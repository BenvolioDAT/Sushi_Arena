import { arenaInfo } from 'game';
import {
    createConstructionSite,
    findClosestByRange,
    findInRange,
    getDirection,
    getObjectById,
    getObjectsByPrototype,
    getRange,
    getTerrainAt,
    getTicks,
} from 'game/utils';
import { searchPath, CostMatrix } from 'game/path-finder';
import {
    ConstructionSite,
    Creep,
    Flag,
    Source,
    Structure,
    StructureContainer,
    StructureExtension,
    StructureRampart,
    StructureRoad,
    StructureSpawn,
    StructureWall,
} from 'game/prototypes';
import { Visual } from 'game/visual';
import {
    ATTACK,
    BODYPART_COST,
    CARRY,
    ERR_NOT_IN_RANGE,
    ERR_TIRED,
    HEAL,
    MOVE,
    OK,
    RANGED_ATTACK,
    RESOURCE_ENERGY,
    SPAWN_RANGE,
    TERRAIN_PLAIN,
    TERRAIN_SWAMP,
    TERRAIN_WALL,
    TOUGH,
    WORK,
} from 'game/constants';

const MAP_MIN = 0;
const MAP_MAX = 99;
const MAP_SIZE = MAP_MAX + 1;

const PATH_RECALC_TICKS = 35;
const STUCK_REPATH_TICKS = 3;
const ROUTE_LOOKAHEAD = 12;
const PATH_MAX_OPS = 12000;
const CENTRAL_LOW = Math.floor(MAP_SIZE * 0.32);
const CENTRAL_HIGH = Math.ceil(MAP_SIZE * 0.68);

const HOME_ENERGY_RADIUS = 28;
const ESCORT_WIN_RANGE = 2;
const EMERGENCY_HEALTH_RATIO = 0.35;

const PHASE_ECONOMY = 'economy';
const PHASE_COMBAT = 'combat';
const PHASE_SIEGE_ENERGY = 'siege-energy';
const PHASE_ESCORT = 'escort';
const PHASE_EMERGENCY_DEFENSE = 'emergency-defense';

const SAFE_HOLD_RANGE_FROM_SPAWN = 4;
const FLAG_DANGER_RANGE = 7;
const ROUTE_DANGER_RANGE = 4;
const FLAG_CLEAR_TICKS_REQUIRED = 25;
const MIN_WORKERS = 1;
const MIN_RANGERS_BEFORE_ESCORT = 3;
const MIN_HEALERS_BEFORE_ESCORT = 1;
const MIN_TUGS_BEFORE_ESCORT = 1;
const OPENING_ATTACK_TICKS = 350;
const OPENING_FIRST_RANGERS = 1;
const OPENING_PRESSURE_RANGERS = 2;
const CENTER_CHOKE = { x: 50, y: 50 };
const CENTER_HOLD_RANGE = 3;
const CENTER_CLEAR_RANGE = 7;
const CENTER_PUSH_RANGE = 14;
const ENEMY_ESCORT_LOCK_RANGE = 9;
const ENEMY_ESCORT_SUPPORT_RANGE = 1;
const COMBAT_TARGET_LOCK_RANGE = 12;
const OPENING_BRUISERS = 1;
const OPENING_RANGERS = 1;
const CENTER_CONTROL_TICKS_REQUIRED = 20;

const DEBUG_LOG_INTERVAL = 50;
const DEBUG_VISUALS = true;

const PART_COST_FALLBACK = {
    [MOVE]: 50,
    [WORK]: 100,
    [CARRY]: 50,
    [ATTACK]: 80,
    [RANGED_ATTACK]: 150,
    [HEAL]: 250,
    [TOUGH]: 10,
};

const state = {
    ids: {
        spawn: null,
        escort: null,
        enemyEscort: null,
        flag: null,
    },
    path: {
        targetId: null,
        routeType: 'none',
        path: [],
        incomplete: true,
        generatedTick: -Infinity,
        nextStep: null,
        blockedTiles: 0,
    },
    phase: PHASE_ECONOMY,
    flagClearTicks: 0,
    centerControlTicks: 0,
    lastPhaseChangeTick: 0,
    enemyEnergyTargetId: null,
    combatTargetIds: new Map(),
    stuck: new Map(),
    lastLogTick: -Infinity,
    lastRejectedRouteLog: -Infinity,
    visual: null,
};

function repeat(part, count) {
    const body = [];
    for (let index = 0; index < count; index += 1) {
        body.push(part);
    }
    return body;
}

const BODY_PLANS = {
    tug: [
        repeat(MOVE, 20),
        repeat(MOVE, 16),
        repeat(MOVE, 12),
        repeat(MOVE, 8),
        repeat(MOVE, 5),
        repeat(MOVE, 3),
        repeat(MOVE, 2),
    ],
    worker: [
        [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
        [WORK, WORK, CARRY, MOVE, MOVE],
        [WORK, CARRY, MOVE],
    ],
    healer: [
        [MOVE, MOVE, HEAL, HEAL],
        [MOVE, HEAL],
    ],
    ranger: [
        [MOVE, MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK],
        [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK],
        [TOUGH, MOVE, RANGED_ATTACK],
        [MOVE, RANGED_ATTACK],
    ],
    melee: [
        [TOUGH, TOUGH, MOVE, MOVE, ATTACK, ATTACK],
        [TOUGH, MOVE, ATTACK],
        [MOVE, ATTACK],
    ],
    bruiser: [
        [TOUGH, TOUGH, MOVE, MOVE, ATTACK, HEAL],
        [TOUGH, MOVE, ATTACK, HEAL],
        [MOVE, ATTACK, HEAL],
    ],
};

function partCost(part) {
    if (BODYPART_COST && BODYPART_COST[part]) {
        return BODYPART_COST[part];
    }
    return PART_COST_FALLBACK[part] || 0;
}

function bodyCost(body) {
    return body.reduce((total, part) => total + partCost(part), 0);
}

function chooseAffordableBody(plans, energy) {
    for (const body of plans) {
        if (bodyCost(body) <= energy) {
            return body;
        }
    }
    return null;
}

function getUsedEnergy(structure) {
    if (!structure || !structure.store) {
        return 0;
    }
    return structure.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
}

function getFreeEnergyCapacity(structure) {
    if (!structure || !structure.store) {
        return 0;
    }
    return structure.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
}

function getAvailableSpawnEnergy(spawn) {
    const extensions = getObjectsByPrototype(StructureExtension).filter(extension =>
        extension.my && getRange(spawn, extension) <= SPAWN_RANGE);

    return getUsedEnergy(spawn) + extensions.reduce(
        (total, extension) => total + getUsedEnergy(extension),
        0
    );
}

function bodyPartCount(creep, partType) {
    if (!creep || !creep.body) {
        return 0;
    }
    return creep.body.filter(part => part.type === partType && part.hits > 0).length;
}

function hasBodyPart(creep, partType) {
    return bodyPartCount(creep, partType) > 0;
}

function activeBodySize(creep) {
    if (!creep || !creep.body) {
        return 0;
    }
    return creep.body.filter(part => part.hits > 0).length;
}

function isTug(creep) {
    const moves = bodyPartCount(creep, MOVE);
    const total = activeBodySize(creep);
    return moves >= 2 &&
        moves * 2 >= Math.max(1, total) &&
        !hasBodyPart(creep, WORK) &&
        !hasBodyPart(creep, CARRY) &&
        !hasBodyPart(creep, ATTACK) &&
        !hasBodyPart(creep, RANGED_ATTACK) &&
        !hasBodyPart(creep, HEAL);
}

function isWorker(creep) {
    return hasBodyPart(creep, WORK) && hasBodyPart(creep, CARRY);
}

function isRanger(creep) {
    return hasBodyPart(creep, RANGED_ATTACK);
}

function isHealer(creep) {
    return hasBodyPart(creep, HEAL);
}

function isMelee(creep) {
    return hasBodyPart(creep, ATTACK);
}

function isBruiser(creep) {
    return hasBodyPart(creep, ATTACK) && hasBodyPart(creep, HEAL);
}

function isDangerous(creep) {
    return hasBodyPart(creep, ATTACK) || hasBodyPart(creep, RANGED_ATTACK);
}

function classifyCreeps(creeps) {
    const roles = {
        tugs: [],
        workers: [],
        rangers: [],
        healers: [],
        melees: [],
        bruisers: [],
        fighters: [],
    };

    for (const creep of creeps) {
        if (isBruiser(creep)) {
            roles.bruisers.push(creep);
            roles.fighters.push(creep);
        }
        if (isTug(creep)) {
            roles.tugs.push(creep);
        }
        if (isWorker(creep)) {
            roles.workers.push(creep);
        }
        if (isRanger(creep)) {
            roles.rangers.push(creep);
            roles.fighters.push(creep);
        }
        if (isHealer(creep)) {
            roles.healers.push(creep);
            roles.fighters.push(creep);
        }
        if (isMelee(creep)) {
            roles.melees.push(creep);
            roles.fighters.push(creep);
        }
    }

    return roles;
}

function rememberId(name, object) {
    state.ids[name] = object && object.exists ? object.id : null;
}

function cachedObject(name) {
    const id = state.ids[name];
    if (!id) {
        return null;
    }
    const object = getObjectById(id);
    return object && object.exists ? object : null;
}

function chooseTargetFlag(flags, mySpawn, enemySpawn, myEscort) {
    if (!flags || flags.length === 0 || !mySpawn) {
        return null;
    }

    // Escort Run marks our destination flag as ours when ownership is known.
    // Never prefer enemy-owned flags for the escort destination.
    const myFlag = flags.find(flag => flag.my === true);
    if (myFlag) {
        return myFlag;
    }

    const nonEnemyFlags = flags.filter(flag => flag.my !== false);
    const candidates = nonEnemyFlags.length > 0 ? nonEnemyFlags : flags;

    // When ownership is missing, choose the far-side flag closest to our
    // spawn/escort Y-lane on the mirrored Escort Run map.
    const anchor = myEscort || mySpawn;
    let best = null;
    let bestScore = Infinity;

    for (const flag of candidates) {
        const horizontalDistance = Math.abs(flag.x - mySpawn.x);
        const sameLanePenalty = Math.abs(flag.y - anchor.y) * 3;
        const score = sameLanePenalty - horizontalDistance * 0.25;

        if (score < bestScore) {
            best = flag;
            bestScore = score;
        }
    }
    return best;
}

function getEscortCreeps(creeps = getObjectsByPrototype(Creep)) {
    const namedEscorts = creeps.filter(creep =>
        creep.constructor &&
        creep.constructor.name === 'EscortCreep'
    );

    if (namedEscorts.length > 0) {
        return namedEscorts;
    }

    return creeps.filter(creep => {
        if (!creep.body || creep.body.length < 10) {
            return false;
        }

        const hasWork = creep.body.some(part => part.type === WORK);
        const hasCarry = creep.body.some(part => part.type === CARRY);
        const hasRanged = creep.body.some(part => part.type === RANGED_ATTACK);
        const hasHeal = creep.body.some(part => part.type === HEAL);

        return !hasWork && !hasCarry && !hasRanged && !hasHeal;
    });
}

function getMyEscort(creeps) {
    return getEscortCreeps(creeps).find(creep => creep.my);
}

function getEnemyEscort(creeps) {
    return getEscortCreeps(creeps).find(creep => creep.my === false);
}

function isStaticBlocker(object) {
    if (!object || !object.exists) {
        return false;
    }

    if (object instanceof StructureRoad || object instanceof StructureContainer) {
        return false;
    }

    if (object instanceof StructureRampart) {
        return object.my === false;
    }

    if (object instanceof StructureWall ||
        object instanceof StructureSpawn ||
        object instanceof StructureExtension) {
        return true;
    }

    return object instanceof Structure;
}

function staticBlockerPositions() {
    return getObjectsByPrototype(Structure).filter(isStaticBlocker);
}

function discoverObjects() {
    const spawns = getObjectsByPrototype(StructureSpawn);
    const cachedSpawn = cachedObject('spawn');
    const mySpawn = cachedSpawn && cachedSpawn.my ? cachedSpawn : spawns.find(spawn => spawn.my);
    const enemySpawn = spawns.find(spawn => spawn.my === false);

    const allCreeps = getObjectsByPrototype(Creep);
    const cachedEscort = cachedObject('escort');
    const cachedEnemyEscort = cachedObject('enemyEscort');
    const myEscort = cachedEscort && cachedEscort.my ? cachedEscort : getMyEscort(allCreeps);
    const enemyEscort = cachedEnemyEscort && cachedEnemyEscort.my === false
        ? cachedEnemyEscort
        : getEnemyEscort(allCreeps);

    const flags = getObjectsByPrototype(Flag);
    const cachedFlag = cachedObject('flag');
    const ownedTargetFlag = flags.find(flag => flag.my === true);
    const targetFlag = cachedFlag &&
        cachedFlag.my !== false &&
        (!ownedTargetFlag || cachedFlag.id === ownedTargetFlag.id) &&
        flags.some(flag => flag.id === cachedFlag.id)
        ? cachedFlag
        : chooseTargetFlag(flags, mySpawn, enemySpawn, myEscort);

    const myEscortId = myEscort ? myEscort.id : null;
    const enemyEscortId = enemyEscort ? enemyEscort.id : null;
    const myCreeps = allCreeps.filter(creep => creep.my && creep.id !== myEscortId);
    const activeMyCreeps = myCreeps.filter(creep => !creep.spawning);
    const enemyCreeps = allCreeps.filter(creep => creep.my === false && creep.id !== enemyEscortId);
    const roads = getObjectsByPrototype(StructureRoad);
    const containers = getObjectsByPrototype(StructureContainer);
    const sites = getObjectsByPrototype(ConstructionSite);

    const context = {
        tick: getTicks(),
        spawns,
        mySpawn,
        enemySpawn,
        myEscort,
        enemyEscort,
        targetFlag,
        flags,
        sources: getObjectsByPrototype(Source),
        containers,
        roads,
        sites,
        allCreeps,
        myCreeps,
        activeMyCreeps,
        enemyCreeps,
        staticBlockers: staticBlockerPositions(),
    };

    rememberId('spawn', mySpawn);
    rememberId('escort', myEscort);
    rememberId('enemyEscort', enemyEscort);
    rememberId('flag', targetFlag);

    return context;
}

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function clampPosition(pos) {
    return {
        x: clamp(Math.round(pos.x), MAP_MIN, MAP_MAX),
        y: clamp(Math.round(pos.y), MAP_MIN, MAP_MAX),
    };
}

function samePosition(a, b) {
    return a && b && a.x === b.x && a.y === b.y;
}

function positionKey(pos) {
    return `${pos.x}:${pos.y}`;
}

function terrainAt(pos) {
    return getTerrainAt(clampPosition(pos));
}

function idIsIgnored(object, ignoreIds) {
    return object && ignoreIds.indexOf(object.id) >= 0;
}

function hasStaticBlockerAt(context, pos) {
    return context.staticBlockers.some(blocker =>
        blocker.x === pos.x && blocker.y === pos.y);
}

function hasCreepBlockerAt(context, pos, ignoreIds = []) {
    const occupants = [
        ...(context.allCreeps || []),
        ...(context.myEscort ? [context.myEscort] : []),
        ...(context.enemyEscort ? [context.enemyEscort] : []),
    ];

    return occupants.some(creep =>
        creep &&
        creep.exists &&
        !creep.spawning &&
        !idIsIgnored(creep, ignoreIds) &&
        samePosition(creep, pos));
}

function isPassablePosition(context, pos, ignoreIds = []) {
    if (!context || !pos) {
        return false;
    }
    if (pos.x < MAP_MIN || pos.x > MAP_MAX || pos.y < MAP_MIN || pos.y > MAP_MAX) {
        return false;
    }
    if (terrainAt(pos) === TERRAIN_WALL) {
        return false;
    }
    if (hasStaticBlockerAt(context, pos)) {
        return false;
    }
    if (hasCreepBlockerAt(context, pos, ignoreIds)) {
        return false;
    }
    return true;
}

function stepToward(from, target) {
    if (!from || !target) {
        return null;
    }
    return {
        x: from.x + clamp(target.x - from.x, -1, 1),
        y: from.y + clamp(target.y - from.y, -1, 1),
    };
}

function setMatrixCost(matrix, x, y, cost) {
    if (x < MAP_MIN || x > MAP_MAX || y < MAP_MIN || y > MAP_MAX) {
        return;
    }
    const current = matrix.get(x, y);
    if (current === 255) {
        return;
    }
    matrix.set(x, y, Math.max(current, cost));
}

function nearEndpoint(pos, origin, target) {
    return getRange(pos, origin) <= 7 || getRange(pos, target) <= 7;
}

function buildCostMatrix(context, origin, target, allowCentral) {
    const matrix = new CostMatrix();

    for (let x = MAP_MIN; x <= MAP_MAX; x += 1) {
        for (let y = MAP_MIN; y <= MAP_MAX; y += 1) {
            const pos = { x, y };
            const terrain = terrainAt(pos);
            if (terrain === TERRAIN_WALL) {
                matrix.set(x, y, 255);
                continue;
            }
            if (terrain === TERRAIN_SWAMP) {
                matrix.set(x, y, 12);
            } else if (terrain === TERRAIN_PLAIN) {
                matrix.set(x, y, 2);
            }

            if (!allowCentral &&
                x >= CENTRAL_LOW &&
                x <= CENTRAL_HIGH &&
                y >= CENTRAL_LOW &&
                y <= CENTRAL_HIGH &&
                !nearEndpoint(pos, origin, target)) {
                setMatrixCost(matrix, x, y, 24);
            }
        }
    }

    for (const blocker of context.staticBlockers) {
        matrix.set(blocker.x, blocker.y, 255);
    }

    for (const creep of context.allCreeps) {
        if (!samePosition(creep, origin)) {
            matrix.set(creep.x, creep.y, 255);
        }
    }

    for (const road of context.roads) {
        if (isPassablePosition(context, road)) {
            matrix.set(road.x, road.y, 1);
        }
    }

    const blockers = [
        ...context.enemyCreeps,
        ...(context.enemyEscort ? [context.enemyEscort] : []),
    ];

    for (const enemy of blockers) {
        for (let dx = -2; dx <= 2; dx += 1) {
            for (let dy = -2; dy <= 2; dy += 1) {
                const x = enemy.x + dx;
                const y = enemy.y + dy;
                const range = Math.max(Math.abs(dx), Math.abs(dy));
                const cost = range === 0 ? 255 : range === 1 ? 45 : 18;
                setMatrixCost(matrix, x, y, cost);
            }
        }
    }

    return matrix;
}

function nearestWalkable(context, pos, maxRadius = 6) {
    const clamped = clampPosition(pos);
    if (isPassablePosition(context, clamped)) {
        return clamped;
    }

    for (let radius = 1; radius <= maxRadius; radius += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
                    continue;
                }
                const candidate = clampPosition({ x: clamped.x + dx, y: clamped.y + dy });
                if (isPassablePosition(context, candidate)) {
                    return candidate;
                }
            }
        }
    }

    return clamped;
}

function uniqueWaypoints(context, waypoints, origin, target) {
    const seen = new Set();
    const filtered = [];
    for (const waypoint of waypoints) {
        const point = nearestWalkable(context, waypoint);
        const key = positionKey(point);
        if (seen.has(key) || getRange(point, origin) <= 2 || getRange(point, target) <= 2) {
            continue;
        }
        seen.add(key);
        filtered.push(point);
    }
    return filtered;
}

function edgeWaypoints(context, origin, target, laneFraction) {
    const y = clamp(Math.round(MAP_MAX * laneFraction), MAP_MIN + 5, MAP_MAX - 5);
    const midX = Math.round((origin.x + target.x) / 2);
    return uniqueWaypoints(context, [
        { x: origin.x, y },
        { x: midX, y },
        { x: target.x, y },
    ], origin, target);
}

function routeCandidates(context, origin, target) {
    return [
        { type: 'direct', waypoints: [], bias: 0 },
        { type: 'lower-pass', waypoints: edgeWaypoints(context, origin, target, 0.84), bias: -35 },
        { type: 'lower-pass-wide', waypoints: edgeWaypoints(context, origin, target, 0.91), bias: -25 },
        { type: 'lower-pass-inner', waypoints: edgeWaypoints(context, origin, target, 0.74), bias: -18 },
        { type: 'upper-pass', waypoints: edgeWaypoints(context, origin, target, 0.16), bias: -12 },
        { type: 'upper-pass-wide', waypoints: edgeWaypoints(context, origin, target, 0.09), bias: -8 },
        { type: 'upper-pass-inner', waypoints: edgeWaypoints(context, origin, target, 0.26), bias: -6 },
    ];
}

function searchSegment(from, to, matrix, isFinal) {
    const goal = isFinal ? to : { pos: to, range: 2 };
    return searchPath(from, goal, {
        costMatrix: matrix,
        plainCost: 2,
        swampCost: 10,
        maxOps: PATH_MAX_OPS,
        heuristicWeight: 1.2,
    });
}

function pathBlockedTiles(context, path) {
    return path.filter(step => !isPassablePosition(context, step));
}

function pathHasBlockedTile(context, path) {
    return pathBlockedTiles(context, path).length > 0;
}

function maybeLogRejectedRoute(context, candidate, blockedCount) {
    if (context.tick - state.lastRejectedRouteLog < DEBUG_LOG_INTERVAL) {
        return;
    }
    state.lastRejectedRouteLog = context.tick;
    console.log(`Rejected ${candidate.type} route: ${blockedCount} blocked path tiles`);
}

function searchCandidate(context, origin, target, matrix, candidate) {
    const stops = [...candidate.waypoints, target];
    let current = origin;
    let fullPath = [];
    let totalCost = candidate.bias;
    let totalOps = 0;
    let incomplete = false;
    let blockedTiles = 0;

    for (let index = 0; index < stops.length; index += 1) {
        const stop = stops[index];
        const result = searchSegment(current, stop, matrix, index === stops.length - 1);
        totalCost += result.cost;
        totalOps += result.ops;
        incomplete = incomplete || result.incomplete || result.path.length === 0;
        fullPath = fullPath.concat(result.path);
        current = result.path.length > 0 ? result.path[result.path.length - 1] : current;

        if (result.incomplete) {
            break;
        }
    }

    blockedTiles = pathBlockedTiles(context, fullPath).length;
    if (blockedTiles > 0) {
        incomplete = true;
        totalCost += 1000000;
        maybeLogRejectedRoute(context, candidate, blockedTiles);
    }

    return {
        routeType: candidate.type,
        path: fullPath,
        cost: totalCost + totalOps * 0.001 + (incomplete ? 100000 : 0),
        incomplete,
        blockedTiles,
    };
}

function chooseRoute(context, origin, target) {
    const matrix = buildCostMatrix(context, origin, target, false);
    let choices = routeCandidates(context, origin, target).map(candidate =>
        searchCandidate(context, origin, target, matrix, candidate));

    if (!choices.some(choice => !choice.incomplete && choice.path.length > 0)) {
        const fallbackMatrix = buildCostMatrix(context, origin, target, true);
        choices = routeCandidates(context, origin, target).map(candidate =>
            searchCandidate(context, origin, target, fallbackMatrix, candidate));
    }

    choices.sort((a, b) => a.cost - b.cost);
    const complete = choices.find(choice => !choice.incomplete && choice.path.length > 0);
    if (complete) {
        return complete;
    }

    const bestRejected = choices[0];
    return {
        routeType: bestRejected ? bestRejected.routeType : 'none',
        path: [],
        incomplete: true,
        blockedTiles: bestRejected ? bestRejected.blockedTiles : 0,
    };
}

function pathIndexNear(context, creep, path) {
    if (!path || path.length === 0) {
        return -1;
    }

    for (let index = 0; index < path.length; index += 1) {
        if (samePosition(creep, path[index])) {
            return index;
        }
    }

    let bestIndex = -1;
    let bestScore = Infinity;
    for (let index = 0; index < path.length; index += 1) {
        const candidate = path[index];
        if (!isPassablePosition(context, candidate, [creep.id])) {
            continue;
        }
        const range = getRange(creep, path[index]);
        if (range <= 1) {
            const directStep = stepToward(creep, candidate);
            if (!isPassablePosition(context, directStep, [creep.id])) {
                continue;
            }
        }
        const score = range * 100 + index * 0.02;
        if (score < bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function nextPathStep(context, creep, path) {
    if (!path || path.length === 0) {
        return null;
    }

    const index = pathIndexNear(context, creep, path);
    if (index < 0) {
        return path[0];
    }

    const onPath = samePosition(creep, path[index]);
    if (onPath) {
        return path[Math.min(path.length - 1, index + 1)];
    }
    return path[index];
}

function moveOneStep(context, creep, target) {
    if (!creep || !target || samePosition(creep, target)) {
        return OK;
    }

    const step = stepToward(creep, target);
    if (!step || samePosition(step, creep)) {
        return OK;
    }

    if (!isPassablePosition(context, step, [creep.id])) {
        return ERR_NOT_IN_RANGE;
    }

    return creep.move(getDirection(step.x - creep.x, step.y - creep.y));
}

function moveAlongPath(context, creep, path) {
    const next = nextPathStep(context, creep, path);
    if (!next) {
        return ERR_NOT_IN_RANGE;
    }

    if (getRange(creep, next) <= 1) {
        return moveOneStep(context, creep, next);
    }

    return creep.moveTo(next);
}

function updateStuck(creep, key) {
    if (!creep) {
        state.stuck.delete(key);
        return 0;
    }

    const previous = state.stuck.get(key);
    if (!previous || previous.x !== creep.x || previous.y !== creep.y) {
        state.stuck.set(key, { x: creep.x, y: creep.y, ticks: 0 });
        return 0;
    }

    if (creep.fatigue > 0) {
        return previous.ticks;
    }

    previous.ticks += 1;
    state.stuck.set(key, previous);
    return previous.ticks;
}

function routeIsBlocked(context, origin) {
    const path = state.path.path;
    if (!path || path.length === 0) {
        return true;
    }

    if (pathHasBlockedTile(context, path)) {
        return true;
    }

    const index = Math.max(0, pathIndexNear(context, origin, path));
    const danger = context.enemyCreeps.filter(enemy => isDangerous(enemy));
    if (context.enemyEscort) {
        danger.push(context.enemyEscort);
    }

    for (let offset = 0; offset < ROUTE_LOOKAHEAD; offset += 1) {
        const step = path[index + offset];
        if (!step) {
            break;
        }
        if (danger.some(enemy => getRange(enemy, step) <= 1)) {
            return true;
        }
    }
    return false;
}

function ensureEscortRoute(context, origin, force = false) {
    if (!origin || !context.targetFlag) {
        state.path.path = [];
        state.path.routeType = 'none';
        state.path.incomplete = true;
        state.path.nextStep = null;
        state.path.blockedTiles = 0;
        return state.path;
    }

    const targetId = context.targetFlag.id;
    const tooOld = context.tick - state.path.generatedTick >= PATH_RECALC_TICKS;
    const wrongTarget = state.path.targetId !== targetId;
    const invalid = state.path.incomplete || state.path.path.length === 0;
    const blocked = routeIsBlocked(context, origin);

    if (force || tooOld || wrongTarget || invalid || blocked) {
        const route = chooseRoute(context, origin, context.targetFlag);
        state.path = {
            targetId,
            routeType: route.routeType,
            path: route.path,
            incomplete: route.incomplete,
            generatedTick: context.tick,
            nextStep: null,
            blockedTiles: route.blockedTiles || 0,
        };
    }

    return state.path;
}

function hostileAttackersNearEscort(context, range = 3) {
    if (!context.myEscort) {
        return [];
    }
    return findInRange(
        context.myEscort,
        context.enemyCreeps.filter(enemy => isDangerous(enemy)),
        range
    );
}

function enemiesNearPosition(enemies, pos, range) {
    if (!pos) {
        return [];
    }
    return enemies.filter(enemy => getRange(enemy, pos) <= range);
}

function dangerousEnemiesNearPosition(enemies, pos, range) {
    return enemiesNearPosition(enemies, pos, range).filter(isDangerous);
}

function routeDangerCount(context, path, range) {
    if (!path || path.length === 0) {
        return 999;
    }

    let danger = 0;
    for (const enemy of context.enemyCreeps) {
        if (!isDangerous(enemy)) {
            continue;
        }

        for (let index = 0; index < path.length; index += 3) {
            if (getRange(enemy, path[index]) <= range) {
                danger += 1;
                break;
            }
        }
    }
    return danger;
}

function flagDangerCount(context) {
    if (!context.targetFlag) {
        return 999;
    }
    return dangerousEnemiesNearPosition(
        context.enemyCreeps,
        context.targetFlag,
        FLAG_DANGER_RANGE
    ).length;
}

function isFlagControlled(context, roles) {
    if (!context.targetFlag) {
        return false;
    }

    const friendlyFightersNearFlag = roles.rangers.filter(ranger =>
        getRange(ranger, context.targetFlag) <= FLAG_DANGER_RANGE
    ).length + roles.melees.filter(melee =>
        getRange(melee, context.targetFlag) <= FLAG_DANGER_RANGE
    ).length;

    return flagDangerCount(context) === 0 && friendlyFightersNearFlag >= 1;
}

function centerEnemies(context, range = CENTER_CLEAR_RANGE) {
    return context.enemyCreeps.filter(enemy =>
        getRange(enemy, CENTER_CHOKE) <= range);
}

function centerDanger(context, range = CENTER_CLEAR_RANGE) {
    return centerEnemies(context, range).filter(isDangerous);
}

function friendlyFightersNearCenter(roles, range = CENTER_CLEAR_RANGE) {
    return roles.fighters.filter(fighter =>
        getRange(fighter, CENTER_CHOKE) <= range);
}

function hasCenterControl(context, roles) {
    const danger = centerDanger(context, CENTER_CLEAR_RANGE).length;
    const friendlies = friendlyFightersNearCenter(roles, CENTER_CLEAR_RANGE).length;
    return danger === 0 && friendlies >= 1;
}

function setPhase(phase, tick) {
    if (state.phase !== phase) {
        state.phase = phase;
        state.lastPhaseChangeTick = tick;
    }
}

function chooseEnemyEnergyTarget(context) {
    const anchor = context.mySpawn || context.myEscort;
    const enemyWorkers = context.enemyCreeps.filter(creep =>
        hasBodyPart(creep, WORK) || hasBodyPart(creep, CARRY));

    if (anchor && enemyWorkers.length > 0) {
        return findClosestByRange(anchor, enemyWorkers);
    }

    const enemySideSources = context.sources.filter(source =>
        context.enemySpawn &&
        context.mySpawn &&
        getRange(source, context.enemySpawn) < getRange(source, context.mySpawn));

    if (anchor && enemySideSources.length > 0) {
        return findClosestByRange(anchor, enemySideSources);
    }

    const containers = enemySideContainers(context);
    if (anchor && containers.length > 0) {
        return findClosestByRange(anchor, containers);
    }

    return context.enemySpawn || context.enemyEscort || null;
}

function updatePhase(context, roles) {
    state.enemyEnergyTargetId = null;

    const spawnDanger = context.mySpawn
        ? dangerousEnemiesNearPosition(context.enemyCreeps, context.mySpawn, 6).length
        : 0;
    const escortDanger = context.myEscort
        ? dangerousEnemiesNearPosition(context.enemyCreeps, context.myEscort, 5).length
        : 0;

    if (isFlagControlled(context, roles)) {
        state.flagClearTicks += 1;
    } else {
        state.flagClearTicks = 0;
    }

    const routeAnchor = roles.tugs[0] || context.myEscort || context.mySpawn;
    if (routeAnchor && context.targetFlag) {
        ensureEscortRoute(context, routeAnchor);
    }

    const routeDanger = routeDangerCount(context, state.path.path, ROUTE_DANGER_RANGE);

    if (spawnDanger > 0 || escortDanger > 0) {
        setPhase(PHASE_EMERGENCY_DEFENSE, context.tick);
        return;
    }

    if (state.phase === PHASE_ESCORT &&
        (flagDangerCount(context) > 0 || routeDanger > 0)) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (hasCenterControl(context, roles)) {
        state.centerControlTicks += 1;
    } else {
        state.centerControlTicks = 0;
    }

    const escortReady = roles.tugs.length >= MIN_TUGS_BEFORE_ESCORT &&
        roles.rangers.length >= MIN_RANGERS_BEFORE_ESCORT &&
        roles.healers.length >= MIN_HEALERS_BEFORE_ESCORT &&
        state.flagClearTicks >= FLAG_CLEAR_TICKS_REQUIRED &&
        state.centerControlTicks >= CENTER_CONTROL_TICKS_REQUIRED &&
        routeDanger === 0;

    const openingAttack = context.tick < OPENING_ATTACK_TICKS;
    const earlyGame = context.tick < 600;
    if (earlyGame && roles.bruisers.length < OPENING_BRUISERS) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }
    if (earlyGame && state.centerControlTicks < CENTER_CONTROL_TICKS_REQUIRED) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (openingAttack && roles.rangers.length < OPENING_FIRST_RANGERS) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (roles.workers.length < MIN_WORKERS) {
        setPhase(PHASE_ECONOMY, context.tick);
        return;
    }

    if (openingAttack && roles.rangers.length < OPENING_PRESSURE_RANGERS) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (roles.rangers.length < MIN_RANGERS_BEFORE_ESCORT ||
        roles.healers.length < MIN_HEALERS_BEFORE_ESCORT) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (flagDangerCount(context) > 0) {
        setPhase(PHASE_COMBAT, context.tick);
        return;
    }

    if (escortReady) {
        setPhase(PHASE_ESCORT, context.tick);
        return;
    }

    const enemyEnergyTarget = chooseEnemyEnergyTarget(context);
    state.enemyEnergyTargetId = enemyEnergyTarget ? enemyEnergyTarget.id : null;
    if (enemyEnergyTarget) {
        setPhase(PHASE_SIEGE_ENERGY, context.tick);
        return;
    }

    setPhase(PHASE_COMBAT, context.tick);
}

function runSpawn(context, roles) {
    const spawn = context.mySpawn;
    if (!spawn || spawn.spawning) {
        return;
    }

    const energy = getAvailableSpawnEnergy(spawn);
    const openingAttack = context.tick < OPENING_ATTACK_TICKS;
    let body = null;

    if (state.phase === PHASE_EMERGENCY_DEFENSE) {
        if (roles.rangers.length < MIN_RANGERS_BEFORE_ESCORT + 1) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.healers.length < MIN_HEALERS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.healer, energy);
        } else if (roles.melees.length < 1) {
            body = chooseAffordableBody(BODY_PLANS.melee, energy);
        }
    } else if (state.phase === PHASE_ECONOMY) {
        if (roles.workers.length < MIN_WORKERS) {
            body = chooseAffordableBody(BODY_PLANS.worker, energy);
        } else if (roles.rangers.length < 1) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.healers.length < MIN_HEALERS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.healer, energy);
        }
    } else if (state.phase === PHASE_COMBAT) {
        if (roles.bruisers.length < OPENING_BRUISERS) {
            body = chooseAffordableBody(BODY_PLANS.bruiser, energy);
        } else if (roles.rangers.length < OPENING_RANGERS) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.workers.length < MIN_WORKERS) {
            body = chooseAffordableBody(BODY_PLANS.worker, energy);
        } else if (roles.rangers.length < MIN_RANGERS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.healers.length < MIN_HEALERS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.healer, energy);
        } else if (roles.tugs.length < MIN_TUGS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.tug, energy);
        }
    } else if (state.phase === PHASE_SIEGE_ENERGY) {
        if (roles.rangers.length < MIN_RANGERS_BEFORE_ESCORT + 2) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.healers.length < MIN_HEALERS_BEFORE_ESCORT + 1) {
            body = chooseAffordableBody(BODY_PLANS.healer, energy);
        } else if (roles.workers.length < MIN_WORKERS) {
            body = chooseAffordableBody(BODY_PLANS.worker, energy);
        } else if (roles.tugs.length < MIN_TUGS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.tug, energy);
        }
    } else if (state.phase === PHASE_ESCORT) {
        if (roles.tugs.length < MIN_TUGS_BEFORE_ESCORT) {
            body = chooseAffordableBody(BODY_PLANS.tug, energy);
        } else if (roles.healers.length < MIN_HEALERS_BEFORE_ESCORT + 1) {
            body = chooseAffordableBody(BODY_PLANS.healer, energy);
        } else if (roles.rangers.length < MIN_RANGERS_BEFORE_ESCORT + 2) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (roles.workers.length < MIN_WORKERS) {
            body = chooseAffordableBody(BODY_PLANS.worker, energy);
        }
    }

    if (!body && roles.tugs.length < MIN_TUGS_BEFORE_ESCORT &&
        roles.workers.length >= MIN_WORKERS &&
        roles.rangers.length >= MIN_RANGERS_BEFORE_ESCORT &&
        roles.healers.length >= MIN_HEALERS_BEFORE_ESCORT) {
        body = chooseAffordableBody(BODY_PLANS.tug, energy);
    }

    if (!body && roles.bruisers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.bruiser, energy);
    }

    if (!body && openingAttack && roles.rangers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.ranger, energy);
    }

    if (!body && roles.rangers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.ranger, energy);
    }

    if (!body && roles.workers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.worker, energy);
    }

    if (!body &&
        roles.tugs.length === 0 &&
        !chooseAffordableBody(BODY_PLANS.worker, energy) &&
        !chooseAffordableBody(BODY_PLANS.ranger, energy) &&
        !chooseAffordableBody(BODY_PLANS.healer, energy)) {
        body = chooseAffordableBody(BODY_PLANS.tug, energy);
    }

    if (body) {
        spawn.spawnCreep(body);
    }
}

function safeEnergyTargets(context, roles) {
    const readyForFarEnergy = roles.tugs.length > 0 &&
        roles.healers.length > 0 &&
        roles.rangers.length > 0;

    const sourceTargets = context.sources
        .filter(source => source.energy > 0)
        .map(source => ({
            object: source,
            type: 'source',
            farPenalty: !readyForFarEnergy &&
                context.mySpawn &&
                getRange(context.mySpawn, source) > HOME_ENERGY_RADIUS
                ? 1000
                : 0,
        }));

    const containerTargets = context.containers
        .filter(container => getUsedEnergy(container) > 0)
        .map(container => ({
            object: container,
            type: 'container',
            farPenalty: !readyForFarEnergy &&
                context.mySpawn &&
                getRange(context.mySpawn, container) > HOME_ENERGY_RADIUS
                ? 1200
                : -5,
        }));

    return [...sourceTargets, ...containerTargets];
}

function chooseWorkerEnergyTarget(worker, context, roles) {
    const targets = safeEnergyTargets(context, roles);
    if (targets.length === 0) {
        return null;
    }

    let best = null;
    let bestScore = Infinity;
    for (const target of targets) {
        const nearbyEnemies = findInRange(target.object, context.enemyCreeps, 5).length;
        const spawnDistance = context.mySpawn ? getRange(context.mySpawn, target.object) : 0;
        const score = getRange(worker, target.object) +
            spawnDistance * 0.2 +
            nearbyEnemies * 30 +
            target.farPenalty;
        if (score < bestScore) {
            bestScore = score;
            best = target;
        }
    }
    return best;
}

function existingRoadAt(context, pos) {
    return context.roads.some(road => samePosition(road, pos));
}

function workerNearRoute(worker, context) {
    const path = state.path.path;
    if (!path || path.length === 0) {
        return false;
    }
    const index = pathIndexNear(context, worker, path);
    return index >= 0 && getRange(worker, path[index]) <= 1;
}

function maybeBuildRouteRoad(worker, context) {
    if (!workerNearRoute(worker, context) ||
        getUsedEnergy(worker) === 0 ||
        !context.mySpawn ||
        getFreeEnergyCapacity(context.mySpawn) > 0 ||
        existingRoadAt(context, worker)) {
        return false;
    }

    const terrain = terrainAt(worker);
    if (terrain !== TERRAIN_SWAMP) {
        return false;
    }

    const site = context.sites.find(existing => samePosition(existing, worker));
    if (site) {
        if (worker.build(site) === ERR_NOT_IN_RANGE) {
            worker.moveTo(site);
        }
        return true;
    }

    const result = createConstructionSite({ x: worker.x, y: worker.y }, StructureRoad);
    if (result.object) {
        worker.build(result.object);
        return true;
    }
    return false;
}

function runWorker(worker, context, roles) {
    if (worker.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        const target = chooseWorkerEnergyTarget(worker, context, roles);
        if (!target) {
            return;
        }
        const result = target.type === 'container'
            ? worker.withdraw(target.object, RESOURCE_ENERGY)
            : worker.harvest(target.object);
        if (result === ERR_NOT_IN_RANGE) {
            worker.moveTo(target.object);
        }
        return;
    }

    if (context.mySpawn && getFreeEnergyCapacity(context.mySpawn) > 0) {
        if (worker.transfer(context.mySpawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            worker.moveTo(context.mySpawn);
        }
        return;
    }

    maybeBuildRouteRoad(worker, context);
}

function escortHealthRatio(escort) {
    if (!escort || !escort.hitsMax) {
        return 1;
    }
    return escort.hits / escort.hitsMax;
}

function canPullStep(context, tug, escort, next) {
    if (!tug || !escort || !next) {
        return false;
    }
    if (getRange(tug, escort) > 1 || getRange(tug, next) > 1) {
        return false;
    }
    if (samePosition(next, tug) || samePosition(next, escort)) {
        return false;
    }
    if (!isPassablePosition(context, next, [tug.id, escort.id])) {
        return false;
    }
    if (!isPassablePosition(context, tug, [tug.id])) {
        return false;
    }
    return true;
}

function runEscortPull(context, roles) {
    const escort = context.myEscort;
    const flag = context.targetFlag;
    const tug = roles.tugs.find(creep => !creep.spawning);

    if (!escort || !flag) {
        state.path.nextStep = null;
        return;
    }

    if (!tug) {
        state.path.nextStep = null;
        escort.moveTo(flag);
        return;
    }

    const stuckTicks = updateStuck(tug, 'tug');
    const forceRepath = stuckTicks >= STUCK_REPATH_TICKS;
    if (forceRepath) {
        state.stuck.set('tug', { x: tug.x, y: tug.y, ticks: 0 });
    }

    if (getRange(tug, escort) > 1) {
        tug.moveTo(escort);
        if (getRange(escort, flag) > ESCORT_WIN_RANGE) {
            escort.moveTo(tug);
        }
        return;
    }

    const healerNearby = roles.healers.some(healer => getRange(healer, escort) <= 3);
    const danger = hostileAttackersNearEscort(context, 3).length > 0;
    if (danger && healerNearby && escortHealthRatio(escort) < EMERGENCY_HEALTH_RATIO) {
        escort.moveTo(tug);
        return;
    }

    const route = ensureEscortRoute(context, tug, forceRepath);
    let next = nextPathStep(context, tug, route.path);
    if (!next) {
        ensureEscortRoute(context, tug, true);
        next = nextPathStep(context, tug, state.path.path);
        if (!canPullStep(context, tug, escort, next)) {
            return;
        }
    }

    if (!canPullStep(context, tug, escort, next)) {
        const freshRoute = ensureEscortRoute(context, tug, true);
        next = nextPathStep(context, tug, freshRoute.path);
        if (!canPullStep(context, tug, escort, next)) {
            return;
        }
    }

    state.path.nextStep = next;
    const moveResult = moveOneStep(context, tug, next);
    if (moveResult === OK || moveResult === ERR_TIRED) {
        tug.pull(escort);
        escort.moveTo(tug);
        return;
    }

    ensureEscortRoute(context, tug, true);
}

function holdEscortNearBase(context) {
    const escort = context.myEscort;
    const spawn = context.mySpawn;
    if (!escort || !spawn) {
        return;
    }

    state.path.nextStep = null;

    if (getRange(escort, spawn) > SAFE_HOLD_RANGE_FROM_SPAWN) {
        escort.moveTo(spawn);
        return;
    }

    const danger = dangerousEnemiesNearPosition(context.enemyCreeps, escort, 5);
    if (danger.length > 0) {
        escort.moveTo(spawn);
    }
}

function runIdleTug(tug, context) {
    const escort = context.myEscort;
    const spawn = context.mySpawn;
    const anchor = escort || spawn;
    if (!anchor) {
        return;
    }

    if (getRange(tug, anchor) > 2) {
        tug.moveTo(anchor);
    }
}

function isEscortPuller(creep, escort) {
    if (!creep || !escort || getRange(creep, escort) > ENEMY_ESCORT_SUPPORT_RANGE) {
        return false;
    }

    const moves = bodyPartCount(creep, MOVE);
    const total = activeBodySize(creep);
    const moveOnly = moves > 0 && moves === total;

    return isTug(creep) || moveOnly;
}

function enemyEscortSupportCreeps(context) {
    if (!context.enemyEscort) {
        return [];
    }

    return context.enemyCreeps.filter(creep =>
        isEscortPuller(creep, context.enemyEscort));
}

function rememberCombatTarget(unit, target) {
    if (unit && target && target.id) {
        state.combatTargetIds.set(unit.id, target.id);
    }
    return target;
}

function lockedCombatTarget(context, unit, maxRange = COMBAT_TARGET_LOCK_RANGE) {
    const targetId = unit ? state.combatTargetIds.get(unit.id) : null;
    if (!targetId) {
        return null;
    }

    const target = getObjectById(targetId);
    const validEnemy = target &&
        target.exists &&
        target.my === false &&
        getRange(unit, target) <= maxRange &&
        (
            (context.enemyEscort && target.id === context.enemyEscort.id) ||
            context.enemyCreeps.some(enemy => enemy.id === target.id)
        );

    if (validEnemy) {
        return target;
    }

    state.combatTargetIds.delete(unit.id);
    return null;
}

function enemyEscortPackageTarget(context, unit, maxRange = ENEMY_ESCORT_LOCK_RANGE) {
    if (!context.enemyEscort || !unit) {
        return null;
    }

    const supports = enemyEscortSupportCreeps(context);
    const escortClose = getRange(unit, context.enemyEscort) <= maxRange;
    const supportClose = supports.some(creep => getRange(unit, creep) <= maxRange);
    const closeToScore = enemyEscortCloseToWinning(context);

    if (!escortClose && !supportClose && !closeToScore) {
        return null;
    }

    if (supports.length > 0) {
        return rememberCombatTarget(unit, findClosestByRange(unit, supports));
    }

    return rememberCombatTarget(unit, context.enemyEscort);
}

function combatFocusTarget(context, unit) {
    const dangerousEnemies = context.enemyCreeps.filter(enemy => isDangerous(enemy));
    const dangerNearEscort = context.myEscort
        ? findInRange(context.myEscort, dangerousEnemies, 4)
        : [];

    if (dangerNearEscort.length > 0) {
        return rememberCombatTarget(unit, findClosestByRange(unit, dangerNearEscort));
    }

    const escortTarget = enemyEscortPackageTarget(context, unit);
    if (escortTarget) {
        return escortTarget;
    }

    const lockedTarget = lockedCombatTarget(context, unit);
    if (lockedTarget) {
        return lockedTarget;
    }

    const dangerNearUnit = findInRange(unit, dangerousEnemies, 4);
    if (dangerNearUnit.length > 0) {
        return rememberCombatTarget(unit, findClosestByRange(unit, dangerNearUnit));
    }
    if (context.enemyCreeps.length > 0) {
        return rememberCombatTarget(unit, findClosestByRange(unit, context.enemyCreeps));
    }
    return null;
}

function enemyEscortCloseToWinning(context) {
    if (!context.enemyEscort || !context.targetFlag) {
        return false;
    }
    return getRange(context.enemyEscort, context.targetFlag) <= 9;
}

function moveAwayFrom(context, creep, dangers) {
    if (dangers.length === 0) {
        return false;
    }

    let dx = 0;
    let dy = 0;
    for (const danger of dangers) {
        dx += Math.sign(creep.x - danger.x);
        dy += Math.sign(creep.y - danger.y);
    }

    const target = clampPosition({
        x: creep.x + clamp(dx, -1, 1),
        y: creep.y + clamp(dy, -1, 1),
    });

    if (!samePosition(target, creep) && isPassablePosition(context, target, [creep.id])) {
        moveOneStep(context, creep, target);
        return true;
    }
    return false;
}

function rangedAttackAndKite(ranger, context, target) {
    const nearbyEnemies = [
        ...findInRange(ranger, context.enemyCreeps, 3),
        ...(context.enemyEscort && getRange(ranger, context.enemyEscort) <= 3 ? [context.enemyEscort] : []),
    ];

    if (nearbyEnemies.length >= 3) {
        ranger.rangedMassAttack();
    } else if (target && getRange(ranger, target) <= 3) {
        ranger.rangedAttack(target);
    }

    const adjacentDanger = nearbyEnemies.filter(enemy =>
        getRange(ranger, enemy) <= 1 || (isDangerous(enemy) && getRange(ranger, enemy) <= 2));
    if (adjacentDanger.length > 0 && moveAwayFrom(context, ranger, adjacentDanger)) {
        return;
    }

    if (target) {
        const range = getRange(ranger, target);
        if (range > 3) {
            ranger.moveTo(target);
        } else if (range < 2) {
            moveAwayFrom(context, ranger, [target]);
        }
        return;
    }
}

function runEmergencyRanger(ranger, context) {
    const spawnDanger = context.mySpawn
        ? dangerousEnemiesNearPosition(context.enemyCreeps, context.mySpawn, 7)
        : [];
    const escortDanger = context.myEscort
        ? dangerousEnemiesNearPosition(context.enemyCreeps, context.myEscort, 7)
        : [];
    const targetPool = [...escortDanger, ...spawnDanger];
    const target = targetPool.length > 0
        ? findClosestByRange(ranger, targetPool)
        : combatFocusTarget(context, ranger);
    if (target) {
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    const anchor = context.myEscort || context.mySpawn;
    if (anchor && getRange(ranger, anchor) > 3) {
        ranger.moveTo(anchor);
    }
}

function runFlagControlRanger(ranger, context) {
    const flag = context.targetFlag;
    if (!flag) {
        return;
    }

    if (enemyEscortCloseToWinning(context)) {
        const escortTarget = enemyEscortPackageTarget(context, ranger, MAP_SIZE);
        rangedAttackAndKite(ranger, context, escortTarget || context.enemyEscort);
        return;
    }

    const enemyAtFlag = dangerousEnemiesNearPosition(context.enemyCreeps, flag, FLAG_DANGER_RANGE);
    const target = enemyAtFlag.length > 0 ? findClosestByRange(ranger, enemyAtFlag) : null;
    if (target) {
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    if (getRange(ranger, flag) > 4) {
        ranger.moveTo(flag);
    }
}

function enemySideContainers(context) {
    return context.containers.filter(container =>
        context.enemySpawn &&
        context.mySpawn &&
        getRange(container, context.enemySpawn) < getRange(container, context.mySpawn));
}

function runSiegeRanger(ranger, context, roles) {
    const nearbyHealer = roles.healers.find(healer => getRange(healer, ranger) <= 3);
    if (ranger.hits < ranger.hitsMax * 0.45 && !nearbyHealer) {
        const healer = roles.healers.length > 0 ? findClosestByRange(ranger, roles.healers) : null;
        const retreat = healer || context.mySpawn || context.myEscort;
        if (retreat) {
            ranger.moveTo(retreat);
        }
        return;
    }

    const escortTarget = enemyEscortPackageTarget(context, ranger);
    if (escortTarget) {
        rangedAttackAndKite(ranger, context, escortTarget);
        return;
    }

    const enemyWorkers = context.enemyCreeps.filter(creep =>
        hasBodyPart(creep, WORK) || hasBodyPart(creep, CARRY));
    const visibleWorker = enemyWorkers.length > 0 ? findClosestByRange(ranger, enemyWorkers) : null;
    if (visibleWorker) {
        rangedAttackAndKite(ranger, context, visibleWorker);
        return;
    }

    const meleeThreats = context.enemyCreeps.filter(enemy =>
        hasBodyPart(enemy, ATTACK) && getRange(ranger, enemy) <= 2);
    if (moveAwayFrom(context, ranger, meleeThreats)) {
        return;
    }

    const target = chooseEnemyEnergyTarget(context);
    state.enemyEnergyTargetId = target ? target.id : null;

    if (context.enemySpawn && getRange(ranger, context.enemySpawn) <= 5) {
        moveAwayFrom(context, ranger, [context.enemySpawn]);
        return;
    }

    if (target) {
        if (target instanceof Source || target instanceof StructureContainer) {
            if (getRange(ranger, target) > 3) {
                ranger.moveTo(target);
            }
            return;
        }
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    const containers = enemySideContainers(context);
    if (containers.length > 0) {
        const container = findClosestByRange(ranger, containers);
        if (getRange(ranger, container) > 3) {
            ranger.moveTo(container);
        }
    }
}

function runEscortGuardRanger(ranger, context, roles) {
    const escort = context.myEscort;
    const routeEnemies = context.enemyCreeps.filter(enemy =>
        isDangerous(enemy) &&
        (escort && getRange(enemy, escort) <= 5));
    const target = routeEnemies.length > 0
        ? findClosestByRange(ranger, routeEnemies)
        : combatFocusTarget(context, ranger);

    if (target) {
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    const anchor = escort || roles.tugs[0] || context.targetFlag;
    if (anchor && getRange(ranger, anchor) > 3) {
        ranger.moveTo(anchor);
    }
}

function hostileCreepsIncludingEscort(context) {
    return [
        ...context.enemyCreeps,
        ...(context.enemyEscort ? [context.enemyEscort] : []),
    ];
}

function runBruiserAttack(bruiser, target) {
    if (!target) {
        return false;
    }

    if (bruiser.attack(target) === ERR_NOT_IN_RANGE) {
        bruiser.moveTo(target);
    }
    return true;
}

function chooseUrgentBruiserTarget(bruiser, context) {
    const enemies = hostileCreepsIncludingEscort(context);
    const dangerousEnemies = enemies.filter(enemy => isDangerous(enemy));
    const adjacentDanger = dangerousEnemies.filter(enemy => getRange(bruiser, enemy) <= 1);
    if (adjacentDanger.length > 0) {
        return findClosestByRange(bruiser, adjacentDanger);
    }

    const adjacentEnemies = enemies.filter(enemy => getRange(bruiser, enemy) <= 1);
    if (adjacentEnemies.length > 0) {
        return findClosestByRange(bruiser, adjacentEnemies);
    }

    const dangerNearBruiser = findInRange(bruiser, dangerousEnemies, 4);
    if (dangerNearBruiser.length > 0) {
        return findClosestByRange(bruiser, dangerNearBruiser);
    }

    if (state.phase !== PHASE_EMERGENCY_DEFENSE) {
        return null;
    }

    const emergencyTargets = dangerousEnemies.filter(enemy =>
        (context.myEscort && getRange(enemy, context.myEscort) <= 7) ||
        (context.mySpawn && getRange(enemy, context.mySpawn) <= 7));

    return emergencyTargets.length > 0
        ? findClosestByRange(bruiser, emergencyTargets)
        : null;
}

function healBruiserIfIdle(bruiser, context, roles) {
    const injuredFriendlies = [
        ...roles.rangers,
        ...roles.bruisers,
        ...roles.workers,
        ...(context.myEscort ? [context.myEscort] : []),
    ].filter(creep =>
        creep &&
        creep.hits < creep.hitsMax &&
        getRange(bruiser, creep) <= 1);

    if (injuredFriendlies.length > 0) {
        injuredFriendlies.sort((a, b) =>
            (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
        bruiser.heal(injuredFriendlies[0]);
    } else if (bruiser.hits < bruiser.hitsMax) {
        bruiser.heal(bruiser);
    }
}

function runBruiser(bruiser, context, roles) {
    const urgentTarget = chooseUrgentBruiserTarget(bruiser, context);
    if (runBruiserAttack(bruiser, urgentTarget)) {
        return;
    }

    const escortTarget = enemyEscortPackageTarget(context, bruiser);
    if (runBruiserAttack(bruiser, escortTarget)) {
        return;
    }

    const centerThreats = centerEnemies(context, CENTER_CLEAR_RANGE);
    if (centerThreats.length > 0) {
        const target = findClosestByRange(bruiser, centerThreats);
        if (runBruiserAttack(bruiser, target)) {
            return;
        }
    }

    if (getRange(bruiser, CENTER_CHOKE) > CENTER_HOLD_RANGE) {
        healBruiserIfIdle(bruiser, context, roles);
        bruiser.moveTo(CENTER_CHOKE);
        return;
    }

    if (state.centerControlTicks >= CENTER_CONTROL_TICKS_REQUIRED) {
        const enemyWorkers = context.enemyCreeps.filter(creep =>
            hasBodyPart(creep, WORK) || hasBodyPart(creep, CARRY));
        const target = enemyWorkers.length > 0
            ? findClosestByRange(bruiser, enemyWorkers)
            : chooseEnemyEnergyTarget(context);

        if (target) {
            if (context.enemySpawn && getRange(bruiser, context.enemySpawn) <= 5) {
                return;
            }
            if (target instanceof Source) {
                healBruiserIfIdle(bruiser, context, roles);
                if (getRange(bruiser, target) > 2) {
                    bruiser.moveTo(target);
                }
                return;
            }
            if (runBruiserAttack(bruiser, target)) {
                return;
            }
        }
    }

    healBruiserIfIdle(bruiser, context, roles);
}

function runCenterSupportRanger(ranger, context, roles) {
    const escortTarget = enemyEscortPackageTarget(context, ranger);
    if (escortTarget) {
        rangedAttackAndKite(ranger, context, escortTarget);
        return;
    }

    const centerThreats = centerDanger(context, CENTER_CLEAR_RANGE);
    if (centerThreats.length > 0) {
        const target = findClosestByRange(ranger, centerThreats);
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    const bruiser = roles.bruisers.length > 0
        ? findClosestByRange(ranger, roles.bruisers)
        : null;
    if (bruiser && getRange(ranger, bruiser) > 3) {
        ranger.moveTo(bruiser);
        return;
    }
    if (!bruiser && getRange(ranger, CENTER_CHOKE) > 4) {
        ranger.moveTo(CENTER_CHOKE);
        return;
    }

    if (state.centerControlTicks >= CENTER_CONTROL_TICKS_REQUIRED) {
        runSiegeRanger(ranger, context, roles);
        return;
    }

    runFlagControlRanger(ranger, context);
}

function runOpeningPressureRanger(ranger, context, roles) {
    if (context.targetFlag) {
        const flagThreats = dangerousEnemiesNearPosition(
            context.enemyCreeps,
            context.targetFlag,
            FLAG_DANGER_RANGE
        );

        if (flagThreats.length > 0) {
            const target = findClosestByRange(ranger, flagThreats);
            rangedAttackAndKite(ranger, context, target);
            return;
        }
    }

    const enemyWorkers = context.enemyCreeps.filter(creep =>
        hasBodyPart(creep, WORK) || hasBodyPart(creep, CARRY));
    if (enemyWorkers.length > 0) {
        const target = findClosestByRange(ranger, enemyWorkers);
        rangedAttackAndKite(ranger, context, target);
        return;
    }

    const energyTarget = chooseEnemyEnergyTarget(context);
    if (energyTarget) {
        if (energyTarget instanceof Source || energyTarget instanceof StructureContainer) {
            if (getRange(ranger, energyTarget) > 3) {
                ranger.moveTo(energyTarget);
            }
            return;
        }

        rangedAttackAndKite(ranger, context, energyTarget);
        return;
    }

    runFlagControlRanger(ranger, context);
}

function isPrimaryFlagRanger(ranger, context, roles) {
    if (!context.targetFlag || roles.rangers.length === 0) {
        return false;
    }
    const closest = findClosestByRange(context.targetFlag, roles.rangers);
    return closest && closest.id === ranger.id;
}

function runRanger(ranger, context, roles) {
    const openingAttack = context.tick < OPENING_ATTACK_TICKS;
    if (openingAttack && state.phase === PHASE_COMBAT) {
        runCenterSupportRanger(ranger, context, roles);
        return;
    }

    if (state.phase === PHASE_EMERGENCY_DEFENSE) {
        runEmergencyRanger(ranger, context);
    } else if (state.phase === PHASE_SIEGE_ENERGY) {
        if ((flagDangerCount(context) > 0 || state.flagClearTicks < FLAG_CLEAR_TICKS_REQUIRED) &&
            isPrimaryFlagRanger(ranger, context, roles)) {
            runFlagControlRanger(ranger, context);
        } else {
            runSiegeRanger(ranger, context, roles);
        }
    } else if (state.phase === PHASE_ESCORT) {
        runEscortGuardRanger(ranger, context, roles);
    } else if (state.phase === PHASE_COMBAT) {
        runCenterSupportRanger(ranger, context, roles);
    } else {
        runFlagControlRanger(ranger, context);
    }
}

function runMelee(melee, context) {
    let target = combatFocusTarget(context, melee);
    if (state.phase === PHASE_COMBAT) {
        const escortTarget = enemyEscortPackageTarget(context, melee);
        if (escortTarget) {
            target = escortTarget;
        } else {
            const centerThreats = centerEnemies(context, CENTER_CLEAR_RANGE);
            target = centerThreats.length > 0 ? findClosestByRange(melee, centerThreats) : target;
        }
    } else if (state.phase === PHASE_SIEGE_ENERGY) {
        const workers = context.enemyCreeps.filter(creep =>
            hasBodyPart(creep, WORK) || hasBodyPart(creep, CARRY));
        target = workers.length > 0 ? findClosestByRange(melee, workers) : target;
    }

    if (!target) {
        const anchor = state.phase === PHASE_COMBAT
            ? CENTER_CHOKE
            : context.myEscort || context.mySpawn;
        if (anchor && getRange(melee, anchor) > 2) {
            melee.moveTo(anchor);
        }
        return;
    }

    if (melee.attack(target) === ERR_NOT_IN_RANGE) {
        melee.moveTo(target);
    }
}

function healPriority(patient, context, roles) {
    if (state.phase === PHASE_ESCORT) {
        if (context.myEscort && patient.id === context.myEscort.id) {
            return 0;
        }
        if (roles.tugs.some(tug => tug.id === patient.id)) {
            return 1;
        }
        if (roles.rangers.some(ranger => ranger.id === patient.id)) {
            return 2;
        }
        if (roles.melees.some(melee => melee.id === patient.id)) {
            return 3;
        }
        if (roles.workers.some(worker => worker.id === patient.id)) {
            return 4;
        }
        return 5;
    }

    if (state.phase === PHASE_EMERGENCY_DEFENSE &&
        context.myEscort &&
        patient.id === context.myEscort.id) {
        return 0;
    }
    if (roles.rangers.some(ranger => ranger.id === patient.id) ||
        roles.melees.some(melee => melee.id === patient.id)) {
        return 0;
    }
    if (roles.healers.some(healer => healer.id === patient.id)) {
        return 1;
    }
    if (roles.tugs.some(tug => tug.id === patient.id)) {
        return 2;
    }
    if (roles.workers.some(worker => worker.id === patient.id)) {
        return 3;
    }
    return 4;
}

function runHealer(healer, context, roles) {
    const candidates = [
        ...(context.myEscort ? [context.myEscort] : []),
        ...roles.tugs,
        ...roles.rangers,
        ...roles.melees,
        ...roles.workers,
        healer,
    ].filter(creep => creep && creep.hits < creep.hitsMax);

    candidates.sort((a, b) => {
        const priorityDiff = healPriority(a, context, roles) - healPriority(b, context, roles);
        if (priorityDiff !== 0) {
            return priorityDiff;
        }
        const missingA = a.hitsMax - a.hits;
        const missingB = b.hitsMax - b.hits;
        return missingB - missingA;
    });

    const patient = candidates[0] || null;
    if (patient) {
        const range = getRange(healer, patient);
        if (range <= 1) {
            healer.heal(patient);
        } else if (range <= 3) {
            healer.rangedHeal(patient);
            healer.moveTo(patient);
        } else {
            healer.moveTo(patient);
        }
        return;
    }

    let follow = null;
    if (state.phase === PHASE_ESCORT) {
        follow = context.myEscort || roles.tugs[0] || context.targetFlag;
    } else if (state.phase === PHASE_EMERGENCY_DEFENSE) {
        follow = context.myEscort || context.mySpawn;
    } else if (roles.rangers.length > 0) {
        follow = findClosestByRange(healer, roles.rangers);
    } else {
        follow = context.mySpawn || context.targetFlag;
    }

    if (follow && getRange(healer, follow) > 2) {
        healer.moveTo(follow);
    }
}

function drawDebug(context, roles) {
    if (!DEBUG_VISUALS) {
        return;
    }

    if (!state.visual) {
        state.visual = new Visual(10, false);
    }
    const visual = state.visual.clear();

    if (state.phase === PHASE_ESCORT && state.path.path.length > 1) {
        for (let index = 1; index < state.path.path.length; index += 3) {
            visual.line(state.path.path[index - 1], state.path.path[index], {
                color: state.path.routeType.startsWith('lower') ? '#00d084' : '#ffd166',
                width: 0.06,
                opacity: 0.35,
            });
        }

        for (const blocked of pathBlockedTiles(context, state.path.path)) {
            visual.circle(blocked, {
                radius: 0.32,
                stroke: '#ff3333',
                fill: '#ff3333',
                opacity: 0.55,
            });
        }
    }

    if (state.path.nextStep) {
        visual.circle(state.path.nextStep, {
            radius: 0.22,
            stroke: '#ffffff',
            fill: '#00d084',
            opacity: 0.7,
        });
    }

    if (context.mySpawn) {
        visual.text(
            `${state.phase} center:${state.centerControlTicks} flag:${state.flagClearTicks} b:${roles.bruisers.length} r:${roles.rangers.length}`,
            { x: context.mySpawn.x, y: context.mySpawn.y - 1 },
            { font: 0.6, color: '#ffffff', backgroundColor: '#202020', backgroundPadding: 0.15 }
        );
    }
    visual.circle(CENTER_CHOKE, {
        radius: CENTER_HOLD_RANGE,
        stroke: '#ff9f1c',
        fill: '#ff9f1c',
        opacity: 0.08,
    });
    if (context.targetFlag) {
        visual.circle(context.targetFlag, { radius: 0.55, stroke: '#00d084', fill: '#00d084', opacity: 0.15 });
        visual.circle(context.targetFlag, {
            radius: FLAG_DANGER_RANGE,
            stroke: flagDangerCount(context) > 0 ? '#ff3333' : '#00d084',
            fill: '#000000',
            opacity: 0.04,
        });
    }
    if (context.enemyEscort) {
        visual.circle(context.enemyEscort, { radius: 0.6, stroke: '#ff4d4d', fill: '#ff4d4d', opacity: 0.18 });
    }
    if (state.enemyEnergyTargetId) {
        const target = getObjectById(state.enemyEnergyTargetId);
        if (target && target.exists) {
            visual.circle(target, { radius: 0.45, stroke: '#ff9f1c', fill: '#ff9f1c', opacity: 0.22 });
        }
    }
}

function logDebug(context, roles) {
    if (context.tick - state.lastLogTick < DEBUG_LOG_INTERVAL) {
        return;
    }

    state.lastLogTick = context.tick;
    const escortRange = context.myEscort && context.targetFlag
        ? getRange(context.myEscort, context.targetFlag)
        : 'n/a';
    const enemyRange = context.enemyEscort && context.targetFlag
        ? getRange(context.enemyEscort, context.targetFlag)
        : 'n/a';
    console.log(
        `[${arenaInfo.name}] tick=${context.tick} phase=${state.phase} route=${state.path.routeType} ` +
        `escortRange=${escortRange} enemyEscortRange=${enemyRange} ` +
        `center=${state.centerControlTicks} flagClear=${state.flagClearTicks} flagDanger=${flagDangerCount(context)} ` +
        `tugs=${roles.tugs.length} workers=${roles.workers.length} ` +
        `bruisers=${roles.bruisers.length} healers=${roles.healers.length} rangers=${roles.rangers.length}`
    );
}

export function loop() {
    const context = discoverObjects();
    if (!context.mySpawn && !context.myEscort) {
        return;
    }

    const rolesIncludingSpawning = classifyCreeps(context.myCreeps);
    const activeRoles = classifyCreeps(context.activeMyCreeps);

    updatePhase(context, activeRoles);
    runSpawn(context, rolesIncludingSpawning);

    if (state.phase === PHASE_ESCORT) {
        runEscortPull(context, activeRoles);
    } else {
        holdEscortNearBase(context);
        for (const tug of activeRoles.tugs) {
            runIdleTug(tug, context);
        }
    }

    for (const worker of activeRoles.workers) {
        runWorker(worker, context, activeRoles);
    }
    for (const bruiser of activeRoles.bruisers) {
        runBruiser(bruiser, context, activeRoles);
    }
    for (const healer of activeRoles.healers) {
        if (!isRanger(healer) && !isMelee(healer) && !isBruiser(healer)) {
            runHealer(healer, context, activeRoles);
        }
    }
    for (const ranger of activeRoles.rangers) {
        runRanger(ranger, context, activeRoles);
    }
    for (const melee of activeRoles.melees) {
        if (!isRanger(melee) && !isBruiser(melee)) {
            runMelee(melee, context);
        }
    }

    drawDebug(context, activeRoles);
    logDebug(context, activeRoles);
}
