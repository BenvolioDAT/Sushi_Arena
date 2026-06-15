import {
    getObjectsByPrototype,
    getRange,
} from 'game/utils';
import {
    Creep,
    StructureSpawn,
    StructureExtension,
} from 'game/prototypes';
import {
    MOVE,
    ATTACK,
    RESOURCE_ENERGY,
    BODYPART_COST,
    SPAWN_RANGE,
    ERR_NOT_IN_RANGE,
} from 'game/constants';

function bodyCost(body) {
    return body.reduce((total, part) => total + BODYPART_COST[part], 0);
}

function getAvailableEnergy(spawn) {
    const extensions = getObjectsByPrototype(StructureExtension).filter(extension =>
        extension.my && getRange(spawn, extension) <= SPAWN_RANGE);

    return spawn.store.getUsedCapacity(RESOURCE_ENERGY) + extensions.reduce(
        (total, extension) =>
            total + extension.store.getUsedCapacity(RESOURCE_ENERGY),
        0
    );
}

function getRushBody(energy) {
    const pairCost = bodyCost([MOVE, ATTACK]);
    const pairCount = Math.min(12, Math.floor(energy / pairCost));
    if (pairCount === 0) {
        return null;
    }

    // Equal MOVE and ATTACK parts keep the creep fast while maximizing damage.
    const body = [];
    for (let index = 0; index < pairCount; index += 1) {
        body.push(MOVE);
    }
    for (let index = 0; index < pairCount; index += 1) {
        body.push(ATTACK);
    }
    return body;
}

function spawnRushCreep(spawn) {
    if (!spawn || spawn.spawning) {
        return;
    }

    const body = getRushBody(getAvailableEnergy(spawn));
    if (body) {
        spawn.spawnCreep(body);
    }
}

function runRushCreep(creep, enemySpawn, enemies) {
    // Do not chase defenders. Attack one only when it is adjacent and blocks
    // the route; otherwise keep every creep moving toward the main objective.
    const blocker = enemies.find(enemy => getRange(creep, enemy) <= 1);
    if (blocker) {
        creep.attack(blocker);
        return;
    }

    if (creep.attack(enemySpawn) === ERR_NOT_IN_RANGE) {
        creep.moveTo(enemySpawn);
    }
}

export function loop() {
    const spawns = getObjectsByPrototype(StructureSpawn);
    const mySpawn = spawns.find(spawn => spawn.my);
    const enemySpawn = spawns.find(spawn => spawn.my === false);
    if (!mySpawn || !enemySpawn) {
        return;
    }

    spawnRushCreep(mySpawn);

    const creeps = getObjectsByPrototype(Creep);
    const myCreeps = creeps.filter(creep => creep.my && !creep.spawning);
    const enemies = creeps.filter(creep => creep.my === false);

    for (const creep of myCreeps) {
        runRushCreep(creep, enemySpawn, enemies);
    }
}
