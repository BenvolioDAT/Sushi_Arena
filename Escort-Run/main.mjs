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
    StructureContainer,
    StructureExtension,
    StructureRoad,
    StructureSpawn,
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
const ASSASSINATION_RANGER_COUNT = 2;
const EMERGENCY_HEALTH_RATIO = 0.35;

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
    },
    stuck: new Map(),
    lastLogTick: -Infinity,
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
        fighters: [],
    };

    for (const creep of creeps) {
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

function chooseTargetFlag(flags, mySpawn, enemySpawn) {
    if (flags.length === 0 || !mySpawn) {
        return null;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const flag of flags) {
        const ownershipScore = flag.my === false ? 10000 : flag.my === undefined ? 8000 : 0;
        const distanceFromHome = getRange(mySpawn, flag) * 20;
        const enemySideScore = enemySpawn ? (MAP_MAX - getRange(enemySpawn, flag)) : 0;
        const score = ownershipScore + distanceFromHome + enemySideScore;

        if (score > bestScore) {
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
    const targetFlag = cachedFlag &&
        cachedFlag.my !== true &&
        flags.some(flag => flag.id === cachedFlag.id)
        ? cachedFlag
        : chooseTargetFlag(flags, mySpawn, enemySpawn);

    const myEscortId = myEscort ? myEscort.id : null;
    const enemyEscortId = enemyEscort ? enemyEscort.id : null;
    const myCreeps = allCreeps.filter(creep => creep.my && creep.id !== myEscortId);
    const activeMyCreeps = myCreeps.filter(creep => !creep.spawning);
    const enemyCreeps = allCreeps.filter(creep => creep.my === false && creep.id !== enemyEscortId);

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
        containers: getObjectsByPrototype(StructureContainer),
        roads: getObjectsByPrototype(StructureRoad),
        sites: getObjectsByPrototype(ConstructionSite),
        myCreeps,
        activeMyCreeps,
        enemyCreeps,
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

function isWalkable(pos) {
    return pos &&
        pos.x >= MAP_MIN &&
        pos.x <= MAP_MAX &&
        pos.y >= MAP_MIN &&
        pos.y <= MAP_MAX &&
        terrainAt(pos) !== TERRAIN_WALL;
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

    for (const road of context.roads) {
        if (isWalkable(road)) {
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

function nearestWalkable(pos, maxRadius = 6) {
    const clamped = clampPosition(pos);
    if (isWalkable(clamped)) {
        return clamped;
    }

    for (let radius = 1; radius <= maxRadius; radius += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
                    continue;
                }
                const candidate = clampPosition({ x: clamped.x + dx, y: clamped.y + dy });
                if (isWalkable(candidate)) {
                    return candidate;
                }
            }
        }
    }

    return clamped;
}

function uniqueWaypoints(waypoints, origin, target) {
    const seen = new Set();
    const filtered = [];
    for (const waypoint of waypoints) {
        const point = nearestWalkable(waypoint);
        const key = positionKey(point);
        if (seen.has(key) || getRange(point, origin) <= 2 || getRange(point, target) <= 2) {
            continue;
        }
        seen.add(key);
        filtered.push(point);
    }
    return filtered;
}

function edgeWaypoints(origin, target, laneFraction) {
    const y = clamp(Math.round(MAP_MAX * laneFraction), MAP_MIN + 5, MAP_MAX - 5);
    const midX = Math.round((origin.x + target.x) / 2);
    return uniqueWaypoints([
        { x: origin.x, y },
        { x: midX, y },
        { x: target.x, y },
    ], origin, target);
}

function routeCandidates(origin, target) {
    return [
        { type: 'direct', waypoints: [], bias: 0 },
        { type: 'lower-pass', waypoints: edgeWaypoints(origin, target, 0.84), bias: -120 },
        { type: 'lower-pass-wide', waypoints: edgeWaypoints(origin, target, 0.91), bias: -90 },
        { type: 'lower-pass-inner', waypoints: edgeWaypoints(origin, target, 0.74), bias: -60 },
        { type: 'upper-pass', waypoints: edgeWaypoints(origin, target, 0.16), bias: -35 },
        { type: 'upper-pass-wide', waypoints: edgeWaypoints(origin, target, 0.09), bias: -20 },
        { type: 'upper-pass-inner', waypoints: edgeWaypoints(origin, target, 0.26), bias: -15 },
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

function searchCandidate(origin, target, matrix, candidate) {
    const stops = [...candidate.waypoints, target];
    let current = origin;
    let fullPath = [];
    let totalCost = candidate.bias;
    let totalOps = 0;
    let incomplete = false;

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

    return {
        routeType: candidate.type,
        path: fullPath,
        cost: totalCost + totalOps * 0.001 + (incomplete ? 100000 : 0),
        incomplete,
    };
}

function chooseRoute(context, origin, target) {
    const matrix = buildCostMatrix(context, origin, target, false);
    let choices = routeCandidates(origin, target).map(candidate =>
        searchCandidate(origin, target, matrix, candidate));

    if (!choices.some(choice => !choice.incomplete && choice.path.length > 0)) {
        const fallbackMatrix = buildCostMatrix(context, origin, target, true);
        choices = routeCandidates(origin, target).map(candidate =>
            searchCandidate(origin, target, fallbackMatrix, candidate));
    }

    choices.sort((a, b) => a.cost - b.cost);
    return choices[0] || {
        routeType: 'none',
        path: [],
        incomplete: true,
    };
}

function pathIndexNear(creep, path) {
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
        const range = getRange(creep, path[index]);
        const score = range * 100 + index * 0.02;
        if (score < bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function nextPathStep(creep, path) {
    if (!path || path.length === 0) {
        return null;
    }

    const index = pathIndexNear(creep, path);
    if (index < 0) {
        return path[0];
    }

    const onPath = samePosition(creep, path[index]);
    if (onPath) {
        return path[Math.min(path.length - 1, index + 1)];
    }
    return path[index];
}

function moveOneStep(creep, target) {
    if (!creep || !target || samePosition(creep, target)) {
        return OK;
    }

    const dx = clamp(target.x - creep.x, -1, 1);
    const dy = clamp(target.y - creep.y, -1, 1);
    if (dx === 0 && dy === 0) {
        return OK;
    }

    return creep.move(getDirection(dx, dy));
}

function moveAlongPath(creep, path) {
    const next = nextPathStep(creep, path);
    if (!next) {
        return ERR_NOT_IN_RANGE;
    }

    if (getRange(creep, next) <= 1) {
        return moveOneStep(creep, next);
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

    const index = Math.max(0, pathIndexNear(origin, path));
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

function runSpawn(context, roles) {
    const spawn = context.mySpawn;
    if (!spawn || spawn.spawning) {
        return;
    }

    const energy = getAvailableSpawnEnergy(spawn);
    let body = null;

    if (roles.tugs.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.tug, energy);
    } else if (roles.workers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.worker, energy);
    } else if (roles.healers.length === 0) {
        body = chooseAffordableBody(BODY_PLANS.healer, energy);
    } else {
        const escortDanger = hostileAttackersNearEscort(context, 5).length > 0;
        const enemyNearWin = context.enemyEscort &&
            context.targetFlag &&
            getRange(context.enemyEscort, context.targetFlag) <= 9;
        const desiredRangers = escortDanger || enemyNearWin ? 3 : 2;

        if (roles.rangers.length < desiredRangers) {
            body = chooseAffordableBody(BODY_PLANS.ranger, energy);
        } else if (escortDanger && roles.melees.length < 1) {
            body = chooseAffordableBody(BODY_PLANS.melee, energy);
        }
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

function workerNearRoute(worker) {
    const path = state.path.path;
    if (!path || path.length === 0) {
        return false;
    }
    const index = pathIndexNear(worker, path);
    return index >= 0 && getRange(worker, path[index]) <= 1;
}

function maybeBuildRouteRoad(worker, context) {
    if (!workerNearRoute(worker) ||
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

function runEscortPull(context, roles) {
    const escort = context.myEscort;
    const flag = context.targetFlag;
    const tug = roles.tugs.find(creep => !creep.spawning);

    if (!escort || !flag) {
        return;
    }

    if (!tug) {
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
        tug.pull(escort);
        escort.moveTo(tug);
        return;
    }

    const route = ensureEscortRoute(context, tug, forceRepath);
    const next = nextPathStep(tug, route.path);
    if (!next) {
        tug.moveTo(flag);
        tug.pull(escort);
        escort.moveTo(tug);
        return;
    }

    const moveResult = getRange(tug, next) <= 1 ? moveOneStep(tug, next) : moveAlongPath(tug, route.path);
    tug.pull(escort);
    escort.moveTo(tug);

    if (moveResult !== OK && moveResult !== ERR_TIRED) {
        ensureEscortRoute(context, tug, true);
    }
}

function combatFocusTarget(context, unit) {
    const escorts = context.enemyEscort ? [context.enemyEscort] : [];
    const dangerNearEscort = context.myEscort
        ? findInRange(context.myEscort, context.enemyCreeps.filter(enemy => isDangerous(enemy)), 4)
        : [];
    const dangerNearUnit = findInRange(unit, context.enemyCreeps.filter(enemy => isDangerous(enemy)), 4);

    if (dangerNearEscort.length > 0) {
        return findClosestByRange(unit, dangerNearEscort);
    }
    if (escorts.length > 0) {
        return escorts[0];
    }
    if (dangerNearUnit.length > 0) {
        return findClosestByRange(unit, dangerNearUnit);
    }
    if (context.enemyCreeps.length > 0) {
        return findClosestByRange(unit, context.enemyCreeps);
    }
    return null;
}

function shouldAssassinate(context, roles) {
    if (!context.enemyEscort || !context.targetFlag) {
        return false;
    }
    if (context.myEscort && getRange(context.myEscort, context.targetFlag) <= 8) {
        return false;
    }
    if (getRange(context.enemyEscort, context.targetFlag) <= 9) {
        return true;
    }
    return roles.rangers.length >= ASSASSINATION_RANGER_COUNT;
}

function moveAwayFrom(creep, dangers) {
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

    if (!samePosition(target, creep) && isWalkable(target)) {
        moveOneStep(creep, target);
        return true;
    }
    return false;
}

function runRanger(ranger, context, roles) {
    const assassination = shouldAssassinate(context, roles);
    const target = assassination && context.enemyEscort
        ? context.enemyEscort
        : combatFocusTarget(context, ranger);

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
    if (adjacentDanger.length > 0 && moveAwayFrom(ranger, adjacentDanger)) {
        return;
    }

    if (target) {
        const range = getRange(ranger, target);
        if (range > 3) {
            ranger.moveTo(target);
        } else if (range < 2) {
            moveAwayFrom(ranger, [target]);
        }
        return;
    }

    const anchor = context.myEscort || roles.tugs[0] || context.targetFlag;
    if (anchor && getRange(ranger, anchor) > 3) {
        ranger.moveTo(anchor);
    }
}

function runMelee(melee, context) {
    const target = combatFocusTarget(context, melee) || context.enemyEscort;
    if (!target) {
        if (context.myEscort && getRange(melee, context.myEscort) > 2) {
            melee.moveTo(context.myEscort);
        }
        return;
    }

    if (melee.attack(target) === ERR_NOT_IN_RANGE) {
        melee.moveTo(target);
    }
}

function healPriority(patient, context, roles) {
    if (context.myEscort && patient.id === context.myEscort.id) {
        return 0;
    }
    if (roles.tugs.some(tug => tug.id === patient.id)) {
        return 1;
    }
    if (roles.rangers.some(ranger => ranger.id === patient.id)) {
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

    const follow = context.myEscort || roles.tugs[0] || context.targetFlag;
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

    if (state.path.path.length > 1) {
        for (let index = 1; index < state.path.path.length; index += 3) {
            visual.line(state.path.path[index - 1], state.path.path[index], {
                color: state.path.routeType.startsWith('lower') ? '#00d084' : '#ffd166',
                width: 0.06,
                opacity: 0.35,
            });
        }
    }

    if (context.mySpawn) {
        visual.text(
            `Escort ${state.path.routeType} t:${roles.tugs.length} r:${roles.rangers.length}`,
            { x: context.mySpawn.x, y: context.mySpawn.y - 1 },
            { font: 0.6, color: '#ffffff', backgroundColor: '#202020', backgroundPadding: 0.15 }
        );
    }
    if (context.targetFlag) {
        visual.circle(context.targetFlag, { radius: 0.55, stroke: '#00d084', fill: '#00d084', opacity: 0.15 });
    }
    if (context.enemyEscort) {
        visual.circle(context.enemyEscort, { radius: 0.6, stroke: '#ff4d4d', fill: '#ff4d4d', opacity: 0.18 });
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
        `[${arenaInfo.name}] tick=${context.tick} route=${state.path.routeType} ` +
        `escortRange=${escortRange} enemyEscortRange=${enemyRange} ` +
        `tugs=${roles.tugs.length} workers=${roles.workers.length} ` +
        `healers=${roles.healers.length} rangers=${roles.rangers.length}`
    );
}

export function loop() {
    const context = discoverObjects();
    if (!context.mySpawn && !context.myEscort) {
        return;
    }

    const rolesIncludingSpawning = classifyCreeps(context.myCreeps);
    const activeRoles = classifyCreeps(context.activeMyCreeps);

    runSpawn(context, rolesIncludingSpawning);
    runEscortPull(context, activeRoles);

    for (const worker of activeRoles.workers) {
        runWorker(worker, context, activeRoles);
    }
    for (const healer of activeRoles.healers) {
        if (!isRanger(healer) && !isMelee(healer)) {
            runHealer(healer, context, activeRoles);
        }
    }
    for (const ranger of activeRoles.rangers) {
        runRanger(ranger, context, activeRoles);
    }
    for (const melee of activeRoles.melees) {
        if (!isRanger(melee)) {
            runMelee(melee, context);
        }
    }

    drawDebug(context, activeRoles);
    logDebug(context, activeRoles);
}
