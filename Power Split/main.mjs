import {
    findClosestByRange,
    getObjectById,
    getObjectsByPrototype,
    getRange,
    getTicks,
} from 'game/utils';
import {
    MOVE,
    ATTACK,
    RANGED_ATTACK,
    HEAL,
    WORK,
    CARRY,
    RESOURCE_ENERGY,
    BODYPART_COST,
    SPAWN_RANGE,
    ERR_NOT_IN_RANGE,
    EFF_RANGED_ATTACK_BOOST,
    EFF_ATTACK_BOOST,
    EFF_HEAL_BOOST,
} from 'game/constants';
import {
    Creep,
    Resource,
    StructureExtension,
    StructureSpawn,
    Source,
    StructureContainer,
    StructureWall,
} from 'game/prototypes';
import { BonusFlag } from 'arena/season_3/power_split/basic/prototypes';

const MAP_MIN = 0;
const MAP_MAX = 99;
const FLAG_WAIT_LIMIT = 140;
const DEFENSE_RANGE = 7;
const FRONT_WALL_RANGE = 3;
const STUCK_TICKS_TO_BREAK_WALL = 3;

const ROLE_FLAG_RUNNER = 'flagRunner';
const ROLE_RANGER = 'ranger';
const ROLE_MELEE = 'melee';
const ROLE_HEALER = 'healer';
const ROLE_WORKER = 'worker';

const PART_COST_FALLBACK = {
    [MOVE]: 50,
    [WORK]: 100,
    [CARRY]: 50,
    [ATTACK]: 80,
    [RANGED_ATTACK]: 150,
    [HEAL]: 250,
};

const state = {
    targetFlagId: null,
    targetFlagKind: RANGED_ATTACK,
    flagCaptured: false,
    flagRunnerId: null,
    firstSpawnDone: false,
    rolesById: new Map(),
    stuckById: new Map(),
    focusTargetId: null,
};

const BODY_PLANS = {
    flagRunner: [
        [MOVE, MOVE, RANGED_ATTACK],
        [MOVE, MOVE, ATTACK],
        [MOVE, ATTACK],
    ],
    ranger: [
        [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, HEAL],
        [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK],
        [MOVE, RANGED_ATTACK],
    ],
    melee: [
        [MOVE, MOVE, ATTACK, ATTACK, HEAL],
        [MOVE, MOVE, ATTACK, ATTACK],
        [MOVE, ATTACK],
    ],
    healer: [
        [MOVE, MOVE, HEAL, HEAL],
        [MOVE, HEAL],
    ],
    worker: [
        [MOVE, WORK, CARRY],
    ],
};

function exists(object) {
    return object && object.exists !== false;
}

function getLiveObjectById(id) {
    if (!id) {
        return null;
    }
    const object = getObjectById(id);
    return exists(object) ? object : null;
}

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

function storeUsed(object, resource = RESOURCE_ENERGY) {
    if (!object || !object.store || typeof object.store.getUsedCapacity !== 'function') {
        return 0;
    }
    return object.store.getUsedCapacity(resource) || 0;
}

function storeFree(object, resource = RESOURCE_ENERGY) {
    if (!object || !object.store || typeof object.store.getFreeCapacity !== 'function') {
        return 0;
    }
    return object.store.getFreeCapacity(resource) || 0;
}

function getAvailableSpawnEnergy(spawn) {
    if (!spawn) {
        return 0;
    }

    const extensions = getObjectsByPrototype(StructureExtension).filter(extension =>
        extension.my && getRange(spawn, extension) <= SPAWN_RANGE);

    return storeUsed(spawn) + extensions.reduce(
        (total, extension) => total + storeUsed(extension),
        0
    );
}

function hasBodyPart(creep, partType) {
    return bodyPartCount(creep, partType) > 0;
}

function bodyPartCount(creep, partType) {
    if (!creep || !creep.body) {
        return 0;
    }
    return creep.body.filter(part => part.type === partType && part.hits > 0).length;
}

function getMySpawn() {
    return getObjectsByPrototype(StructureSpawn).find(spawn => spawn.my) || null;
}

function getEnemySpawn() {
    return getObjectsByPrototype(StructureSpawn).find(spawn => spawn.my === false) || null;
}

function getBonusFlags() {
    return getObjectsByPrototype(BonusFlag).filter(flag => exists(flag));
}

function flagText(flag) {
    const values = [
        flag.effectType,
        flag.bonusType,
        flag.boostType,
        flag.type,
        flag.name,
        flag.effect && flag.effect.effectType,
        flag.effect && flag.effect.type,
        flag.effect && flag.effect.name,
    ];

    if (Array.isArray(flag.effects)) {
        for (const effect of flag.effects) {
            values.push(effect.effectType, effect.type, effect.name);
        }
    }

    return values
        .filter(value => value !== undefined && value !== null)
        .join(' ')
        .toLowerCase();
}

function flagKind(flag) {
    const text = flagText(flag);
    if (text.includes('ranged') || text.includes(EFF_RANGED_ATTACK_BOOST)) {
        return RANGED_ATTACK;
    }
    if (text.includes('heal') || text.includes(EFF_HEAL_BOOST)) {
        return HEAL;
    }
    if (text.includes('attack') || text.includes(EFF_ATTACK_BOOST)) {
        return ATTACK;
    }
    return null;
}

function chooseBonusFlag(flags, mySpawn, enemySpawn) {
    if (!flags || flags.length === 0) {
        return null;
    }

    // The ranged boost is safest against unknown bots, but fall back to any
    // known damage or healing boost if the map/API does not expose that flag.
    const preferredKinds = [RANGED_ATTACK, ATTACK, HEAL];
    for (const kind of preferredKinds) {
        const candidates = flags.filter(flag => flagKind(flag) === kind);
        if (candidates.length > 0) {
            return {
                flag: chooseClosestToRoute(candidates, mySpawn, enemySpawn),
                kind,
            };
        }
    }

    // If the seasonal object hides the boost type, any early flag is better
    // than waiting. Prefer one that is naturally on the route to the enemy.
    return {
        flag: chooseClosestToRoute(flags, mySpawn, enemySpawn),
        kind: RANGED_ATTACK,
    };
}

function chooseClosestToRoute(objects, mySpawn, enemySpawn) {
    if (!mySpawn) {
        return objects[0] || null;
    }
    if (!enemySpawn) {
        return findClosestByRange(mySpawn, objects);
    }

    let best = null;
    let bestScore = Infinity;
    const directDistance = Math.max(1, getRange(mySpawn, enemySpawn));

    for (const object of objects) {
        const routeScore =
            getRange(mySpawn, object) +
            getRange(object, enemySpawn) -
            directDistance;
        const score = routeScore * 4 + getRange(mySpawn, object);
        if (score < bestScore) {
            bestScore = score;
            best = object;
        }
    }
    return best;
}

function updateFlagState(context) {
    if (state.flagCaptured) {
        context.targetFlag = null;
        return;
    }

    // Bonus flags disappear after capture. Once our chosen flag is gone, stop
    // spending movement on flags and turn every fighting creep toward the spawn.
    let targetFlag = getLiveObjectById(state.targetFlagId);
    if (state.targetFlagId && !targetFlag) {
        state.flagCaptured = true;
        context.targetFlag = null;
        return;
    }

    if (!state.targetFlagId) {
        const chosen = chooseBonusFlag(context.flags, context.mySpawn, context.enemySpawn);
        targetFlag = chosen ? chosen.flag : null;
        state.targetFlagId = targetFlag ? targetFlag.id : null;
        state.targetFlagKind = chosen ? chosen.kind : RANGED_ATTACK;
    }

    const runner = getLiveObjectById(state.flagRunnerId);
    if (!state.targetFlagId || context.tick > FLAG_WAIT_LIMIT) {
        state.flagCaptured = true;
    }
    if (runner && targetFlag && getRange(runner, targetFlag) === 0) {
        state.flagCaptured = true;
    }

    context.targetFlag = state.flagCaptured ? null : targetFlag;
}

function inferRole(creep) {
    const savedRole = state.rolesById.get(creep.id);
    if (savedRole) {
        return savedRole;
    }
    if (state.flagRunnerId === creep.id && !state.flagCaptured) {
        return ROLE_FLAG_RUNNER;
    }
    if (hasBodyPart(creep, WORK) && hasBodyPart(creep, CARRY)) {
        return ROLE_WORKER;
    }
    if (hasBodyPart(creep, HEAL) && !hasBodyPart(creep, ATTACK) && !hasBodyPart(creep, RANGED_ATTACK)) {
        return ROLE_HEALER;
    }
    if (hasBodyPart(creep, RANGED_ATTACK)) {
        return ROLE_RANGER;
    }
    if (hasBodyPart(creep, ATTACK)) {
        return ROLE_MELEE;
    }
    return ROLE_MELEE;
}

function classifyCreeps(myCreeps) {
    const roles = {
        flagRunners: [],
        rangers: [],
        melees: [],
        healers: [],
        workers: [],
        fighters: [],
        combat: [],
    };

    const liveIds = new Set(myCreeps.map(creep => creep.id));
    for (const id of state.rolesById.keys()) {
        if (!liveIds.has(id)) {
            state.rolesById.delete(id);
            state.stuckById.delete(id);
        }
    }

    for (const creep of myCreeps) {
        const role = inferRole(creep);
        state.rolesById.set(creep.id, role);

        if (role === ROLE_FLAG_RUNNER) {
            roles.flagRunners.push(creep);
        } else if (role === ROLE_RANGER) {
            roles.rangers.push(creep);
        } else if (role === ROLE_MELEE) {
            roles.melees.push(creep);
        } else if (role === ROLE_HEALER) {
            roles.healers.push(creep);
        } else if (role === ROLE_WORKER) {
            roles.workers.push(creep);
        }

        if (hasBodyPart(creep, ATTACK) || hasBodyPart(creep, RANGED_ATTACK) || hasBodyPart(creep, HEAL)) {
            roles.fighters.push(creep);
        }
        if (hasBodyPart(creep, ATTACK) || hasBodyPart(creep, RANGED_ATTACK)) {
            roles.combat.push(creep);
        }
    }

    return roles;
}

function spawnWithRole(spawn, body, role) {
    if (!spawn || !body) {
        return false;
    }
    const result = spawn.spawnCreep(body);
    if (result && result.object) {
        state.rolesById.set(result.object.id, role);
        if (role === ROLE_FLAG_RUNNER) {
            state.flagRunnerId = result.object.id;
        }
        state.firstSpawnDone = true;
        return true;
    }
    return false;
}

function spawnManager(context, roles) {
    const spawn = context.mySpawn;
    if (!spawn || spawn.spawning) {
        return;
    }

    // Spend the spawn on immediate pressure first: a runner, then damage, then
    // just enough healing and economy to keep the attack from stalling.
    const energy = getAvailableSpawnEnergy(spawn);
    const threats = getSpawnThreats(context);
    const hasSources = context.sources.length > 0 || context.containers.some(container => storeUsed(container) > 0);

    if (!state.firstSpawnDone && !state.flagCaptured) {
        spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.flagRunner, energy), ROLE_FLAG_RUNNER);
        return;
    }

    if (threats.length > 0 && roles.combat.length < 2) {
        const body = chooseAffordableBody(BODY_PLANS.melee, energy) ||
            chooseAffordableBody(BODY_PLANS.ranger, energy);
        spawnWithRole(spawn, body, body && body.includes(RANGED_ATTACK) ? ROLE_RANGER : ROLE_MELEE);
        return;
    }

    const desiredHealers = roles.combat.length >= 3 ? Math.min(2, Math.floor(roles.combat.length / 3)) : 0;
    if (roles.healers.length < desiredHealers) {
        spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.healer, energy), ROLE_HEALER);
        return;
    }

    if (hasSources && context.tick < 650 && roles.workers.length < 1 && roles.combat.length >= 2) {
        if (spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.worker, energy), ROLE_WORKER)) {
            return;
        }
    }

    if (state.targetFlagKind === RANGED_ATTACK) {
        if (roles.rangers.length <= roles.melees.length + 1) {
            spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.ranger, energy), ROLE_RANGER);
            return;
        }
        spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.melee, energy), ROLE_MELEE);
        return;
    }

    if (state.targetFlagKind === ATTACK) {
        if (roles.melees.length <= roles.rangers.length + 1) {
            spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.melee, energy), ROLE_MELEE);
            return;
        }
        spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.ranger, energy), ROLE_RANGER);
        return;
    }

    if (roles.healers.length < Math.max(1, Math.floor(roles.combat.length / 2))) {
        spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.healer, energy), ROLE_HEALER);
        return;
    }
    spawnWithRole(spawn, chooseAffordableBody(BODY_PLANS.ranger, energy), ROLE_RANGER);
}

function isDangerous(enemy) {
    return hasBodyPart(enemy, ATTACK) || hasBodyPart(enemy, RANGED_ATTACK);
}

function isHealer(enemy) {
    return hasBodyPart(enemy, HEAL);
}

function getSpawnThreats(context) {
    if (!context.mySpawn) {
        return [];
    }
    return context.enemies.filter(enemy =>
        getRange(enemy, context.mySpawn) <= DEFENSE_RANGE &&
        (isDangerous(enemy) || isHealer(enemy) || getRange(enemy, context.mySpawn) <= 3));
}

function lowestHits(objects) {
    let best = null;
    let bestScore = Infinity;
    for (const object of objects) {
        const hits = object.hits === undefined ? 100000 : object.hits;
        if (hits < bestScore) {
            bestScore = hits;
            best = object;
        }
    }
    return best;
}

function closestToAny(objects, anchors) {
    if (!objects || objects.length === 0) {
        return null;
    }
    if (!anchors || anchors.length === 0) {
        return objects[0];
    }

    let best = null;
    let bestScore = Infinity;
    for (const object of objects) {
        const score = Math.min(...anchors.map(anchor => getRange(object, anchor)));
        if (score < bestScore) {
            bestScore = score;
            best = object;
        }
    }
    return best;
}

function wallIsNearFront(wall, context) {
    if (!context.enemySpawn) {
        return false;
    }
    const frontAnchors = context.myCombat.length > 0 ? context.myCombat : [context.mySpawn].filter(Boolean);
    const nearFront = frontAnchors.some(creep => getRange(creep, wall) <= FRONT_WALL_RANGE);
    const notBehindArmy = frontAnchors.some(creep =>
        getRange(wall, context.enemySpawn) <= getRange(creep, context.enemySpawn) + 2);
    return nearFront && notBehindArmy;
}

function getBestEnemyTarget(context, actor = null) {
    const spawnThreats = getSpawnThreats(context);
    if (spawnThreats.length > 0) {
        const dangerousThreats = spawnThreats.filter(isDangerous);
        return lowestHits(dangerousThreats.length > 0 ? dangerousThreats : spawnThreats);
    }

    const anchors = actor ? [actor] : context.myCombat;
    const closeDanger = context.enemies.filter(enemy =>
        isDangerous(enemy) &&
        anchors.some(anchor => getRange(enemy, anchor) <= 5));
    if (closeDanger.length > 0) {
        return lowestHits(closeDanger);
    }

    const healers = context.enemies.filter(isHealer);
    if (healers.length > 0) {
        return closestToAny(healers, anchors);
    }

    const frontWalls = context.walls.filter(wall => wallIsNearFront(wall, context));
    if (frontWalls.length > 0) {
        return lowestHits(frontWalls);
    }

    return context.enemySpawn;
}

function updateFocusTarget(context) {
    const current = getLiveObjectById(state.focusTargetId);
    if (current &&
        current.hits !== 0 &&
        (context.enemies.includes(current) || context.walls.includes(current) || current === context.enemySpawn)) {
        return current;
    }

    const target = getBestEnemyTarget(context);
    state.focusTargetId = target ? target.id : null;
    return target;
}

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function kiteAwayFrom(creep, threats) {
    const nearby = threats.filter(threat => getRange(creep, threat) <= 1);
    if (nearby.length === 0) {
        return false;
    }

    let dx = 0;
    let dy = 0;
    for (const threat of nearby) {
        dx += creep.x - threat.x;
        dy += creep.y - threat.y;
    }

    creep.moveTo({
        x: clamp(creep.x + clamp(dx, -1, 1), MAP_MIN, MAP_MAX),
        y: clamp(creep.y + clamp(dy, -1, 1), MAP_MIN, MAP_MAX),
    });
    return true;
}

function countHostilesNear(context, target, range) {
    return context.enemies.filter(enemy => getRange(enemy, target) <= range).length;
}

function chooseRangedTarget(creep, context, focusTarget) {
    const inRange = [
        ...context.enemies,
        ...context.walls.filter(wall => wallIsNearFront(wall, context)),
        context.enemySpawn,
    ].filter(target => target && getRange(creep, target) <= 3);

    if (focusTarget && inRange.includes(focusTarget)) {
        return focusTarget;
    }

    const dangerous = inRange.filter(target => target instanceof Creep && isDangerous(target));
    if (dangerous.length > 0) {
        return lowestHits(dangerous);
    }

    const healers = inRange.filter(target => target instanceof Creep && isHealer(target));
    if (healers.length > 0) {
        return lowestHits(healers);
    }

    return lowestHits(inRange);
}

function runRangedAttack(creep, context, focusTarget) {
    const hostileCount = countHostilesNear(context, creep, 3);
    if (hostileCount >= 3 || countHostilesNear(context, creep, 1) >= 2) {
        creep.rangedMassAttack();
        return true;
    }

    const target = chooseRangedTarget(creep, context, focusTarget);
    if (target) {
        creep.rangedAttack(target);
        return true;
    }
    return false;
}

function runMeleeAttack(creep, target) {
    if (!target) {
        return false;
    }
    if (creep.attack(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
    return true;
}

function nearestFrontWall(creep, context) {
    const walls = context.walls.filter(wall =>
        getRange(creep, wall) <= FRONT_WALL_RANGE &&
        (!context.enemySpawn || getRange(wall, context.enemySpawn) <= getRange(creep, context.enemySpawn) + 3));

    return walls.length > 0 ? lowestHits(walls) : null;
}

function rememberStuck(creep, goal) {
    if (!goal) {
        return 0;
    }

    const key = creep.id;
    const last = state.stuckById.get(key);
    if (!last || last.goalId !== goal.id) {
        state.stuckById.set(key, {
            x: creep.x,
            y: creep.y,
            goalId: goal.id,
            ticks: 0,
        });
        return 0;
    }

    const ticks = last.x === creep.x && last.y === creep.y ? last.ticks + 1 : 0;
    state.stuckById.set(key, {
        x: creep.x,
        y: creep.y,
        goalId: goal.id,
        ticks,
    });
    return ticks;
}

function wallBreakerLogic(creep, context, goal) {
    const stuckTicks = rememberStuck(creep, goal);
    if (stuckTicks < STUCK_TICKS_TO_BREAK_WALL && hasBodyPart(creep, ATTACK)) {
        return false;
    }

    // Only attack walls near the front. This avoids wasting the whole army on
    // random secret-passage walls that are nowhere near the current push.
    const wall = nearestFrontWall(creep, context);
    if (!wall) {
        return false;
    }

    if (hasBodyPart(creep, ATTACK)) {
        if (creep.attack(wall) === ERR_NOT_IN_RANGE) {
            creep.moveTo(wall);
        }
        return true;
    }

    if (hasBodyPart(creep, RANGED_ATTACK) && getRange(creep, wall) <= 3) {
        creep.rangedAttack(wall);
        return true;
    }

    return false;
}

function healLogic(healer, context, roles) {
    if (!hasBodyPart(healer, HEAL)) {
        return false;
    }

    // A healer that dies saves nobody, so self-heal comes before supporting the
    // lowest-health nearby fighter.
    if (healer.hits < healer.hitsMax * 0.55) {
        healer.heal(healer);
        return true;
    }

    const patients = [
        ...roles.combat,
        ...roles.flagRunners,
        ...roles.healers,
        healer,
    ].filter(creep => creep && creep.hits < creep.hitsMax);

    patients.sort((a, b) => {
        const missingA = a.hitsMax - a.hits;
        const missingB = b.hitsMax - b.hits;
        const rangeA = getRange(healer, a);
        const rangeB = getRange(healer, b);
        return (rangeA - rangeB) || (missingB - missingA);
    });

    const patient = patients[0] || null;
    if (patient) {
        const range = getRange(healer, patient);
        if (range <= 1) {
            healer.heal(patient);
            return true;
        }
        if (range <= 3) {
            healer.rangedHeal(patient);
            return true;
        }
    }

    return false;
}

function shouldGroupBeforeEngage(creep, context, roles) {
    if (!context.enemySpawn || getRange(creep, context.enemySpawn) <= 5) {
        return false;
    }

    const nearbyDanger = context.enemies.filter(enemy =>
        isDangerous(enemy) && getRange(creep, enemy) <= 6);
    const nearbyFriends = roles.combat.filter(friend =>
        friend.id !== creep.id && getRange(creep, friend) <= 4);

    return nearbyDanger.length >= 3 && nearbyFriends.length === 0;
}

function moveToGroup(creep, context, roles) {
    const friends = roles.combat.filter(friend => friend.id !== creep.id);
    const anchor = friends.length > 0
        ? findClosestByRange(creep, friends)
        : context.mySpawn;
    if (anchor) {
        creep.moveTo(anchor);
    }
}

function attackOrMove(creep, context, target, desiredRange) {
    if (!target) {
        return;
    }
    if (wallBreakerLogic(creep, context, target)) {
        return;
    }
    if (getRange(creep, target) > desiredRange) {
        creep.moveTo(target);
    }
}

function runFlagRunner(creep, context, roles) {
    if (!state.flagCaptured && context.targetFlag) {
        if (getRange(creep, context.targetFlag) > 0) {
            creep.moveTo(context.targetFlag);
        }
        if (hasBodyPart(creep, RANGED_ATTACK)) {
            runRangedAttack(creep, context, context.focusTarget);
        }
        if (hasBodyPart(creep, HEAL)) {
            healLogic(creep, context, roles);
        }
        return;
    }

    runCombatCreep(creep, context, roles);
}

function runCombatCreep(creep, context, roles) {
    const focusTarget = context.focusTarget || getBestEnemyTarget(context, creep);
    const spawnThreats = getSpawnThreats(context);
    const defendingSpawn = spawnThreats.length > 0 && context.mySpawn && getRange(creep, context.mySpawn) <= 10;
    const target = defendingSpawn
        ? lowestHits(spawnThreats.filter(isDangerous).length > 0 ? spawnThreats.filter(isDangerous) : spawnThreats)
        : focusTarget;

    if (hasBodyPart(creep, HEAL)) {
        healLogic(creep, context, roles);
    }

    if (hasBodyPart(creep, RANGED_ATTACK)) {
        // Rangers shoot first, then move. They prefer range 2-3 and step back
        // from adjacent melee so they do not trade like melee creeps.
        runRangedAttack(creep, context, target);
        const meleeThreats = context.enemies.filter(enemy => hasBodyPart(enemy, ATTACK));
        if (kiteAwayFrom(creep, meleeThreats)) {
            return;
        }
        if (shouldGroupBeforeEngage(creep, context, roles)) {
            moveToGroup(creep, context, roles);
            return;
        }
        attackOrMove(creep, context, target || context.enemySpawn, 3);
        return;
    }

    if (hasBodyPart(creep, ATTACK)) {
        if (shouldGroupBeforeEngage(creep, context, roles)) {
            moveToGroup(creep, context, roles);
            return;
        }
        if (runMeleeAttack(creep, target || context.enemySpawn)) {
            return;
        }
    }

    if (context.enemySpawn) {
        creep.moveTo(context.enemySpawn);
    }
}

function runHealer(healer, context, roles) {
    if (healLogic(healer, context, roles)) {
        const patient = roles.combat
            .filter(creep => creep.hits < creep.hitsMax)
            .sort((a, b) => getRange(healer, a) - getRange(healer, b))[0];
        if (patient && getRange(healer, patient) > 1) {
            healer.moveTo(patient);
        }
        return;
    }

    const anchor = roles.combat.length > 0
        ? findClosestByRange(healer, roles.combat)
        : context.mySpawn;
    if (anchor && getRange(healer, anchor) > 2) {
        healer.moveTo(anchor);
    }
}

function getDroppedEnergy() {
    return getObjectsByPrototype(Resource).filter(resource =>
        resource.resourceType === RESOURCE_ENERGY && resource.amount > 0);
}

function runWorker(worker, context) {
    if (!context.mySpawn) {
        return;
    }

    // Economy is intentionally tiny. One worker opportunistically brings energy
    // home, but if there is nothing useful to gather it joins the spawn push.
    const carried = storeUsed(worker);
    const free = storeFree(worker);

    if (carried > 0 && (free === 0 || storeFree(context.mySpawn) > 0)) {
        if (worker.transfer(context.mySpawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            worker.moveTo(context.mySpawn);
        }
        return;
    }

    const dropped = getDroppedEnergy();
    if (free > 0 && dropped.length > 0) {
        const resource = findClosestByRange(worker, dropped);
        if (worker.pickup(resource) === ERR_NOT_IN_RANGE) {
            worker.moveTo(resource);
        }
        return;
    }

    const richContainers = context.containers.filter(container => storeUsed(container) > 0);
    if (free > 0 && richContainers.length > 0) {
        const container = findClosestByRange(worker, richContainers);
        if (worker.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            worker.moveTo(container);
        }
        return;
    }

    const activeSources = context.sources.filter(source => source.energy === undefined || source.energy > 0);
    if (free > 0 && activeSources.length > 0) {
        const source = findClosestByRange(worker, activeSources);
        if (worker.harvest(source) === ERR_NOT_IN_RANGE) {
            worker.moveTo(source);
        }
        return;
    }

    if (context.enemySpawn) {
        worker.moveTo(context.enemySpawn);
    }
}

function buildContext() {
    const allCreeps = getObjectsByPrototype(Creep);
    const myCreeps = allCreeps.filter(creep => creep.my && !creep.spawning);
    const enemies = allCreeps.filter(creep => creep.my === false && !creep.spawning);

    return {
        tick: getTicks(),
        mySpawn: getMySpawn(),
        enemySpawn: getEnemySpawn(),
        flags: getBonusFlags(),
        targetFlag: null,
        enemies,
        myCreeps,
        myCombat: [],
        sources: getObjectsByPrototype(Source).filter(exists),
        containers: getObjectsByPrototype(StructureContainer).filter(exists),
        walls: getObjectsByPrototype(StructureWall).filter(exists),
        focusTarget: null,
    };
}

export function loop() {
    const context = buildContext();
    if (!context.mySpawn && context.myCreeps.length === 0) {
        return;
    }

    updateFlagState(context);

    const roles = classifyCreeps(context.myCreeps);
    context.myCombat = roles.combat;
    context.focusTarget = updateFocusTarget(context);

    spawnManager(context, roles);

    for (const worker of roles.workers) {
        runWorker(worker, context);
    }
    for (const healer of roles.healers) {
        runHealer(healer, context, roles);
    }
    for (const runner of roles.flagRunners) {
        runFlagRunner(runner, context, roles);
    }
    for (const ranger of roles.rangers) {
        runCombatCreep(ranger, context, roles);
    }
    for (const melee of roles.melees) {
        runCombatCreep(melee, context, roles);
    }
}
