import { getObjectsByPrototype, findClosestByRange, getRange } from 'game/utils';
import {
    Creep,
    Source,
    Structure,
    StructureSpawn,
    StructureExtension,
    StructureTower,
    ConstructionSite,
    Resource,
} from 'game/prototypes';
import {
    WORK,
    CARRY,
    MOVE,
    ATTACK,
    RANGED_ATTACK,
    HEAL,
    TOUGH,
    RESOURCE_ENERGY,
    ERR_NOT_IN_RANGE,
} from 'game/constants';

function getMyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my);
}

function getEnemyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my === false);
}

function getMySpawns() {
    return getObjectsByPrototype(StructureSpawn).filter(spawn => spawn.my);
}

function getNearestActiveSource(creep) {
    const sources = getObjectsByPrototype(Source).filter(source => source.energy > 0);
    return sources.length > 0 ? findClosestByRange(creep, sources) : null;
}

function harvestOrMove(creep, source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source);
    }
}

function transferOrMove(creep, target) {
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
}

function buildOrMove(creep, site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
        creep.moveTo(site);
    }
}

function hasBodyPart(creep, partType) {
    return creep.body.some(part => part.type === partType && part.hits > 0);
}

function countBodyParts(creep, partType) {
    return creep.body.filter(part => part.type === partType && part.hits > 0).length;
}

function spawnIfNeeded(spawn, body, currentCount, desiredCount) {
    if (!spawn.spawning && currentCount < desiredCount) {
        spawn.spawnCreep(body);
    }
}

const DESIRED_HARVESTERS = 2;
const DESIRED_REFILLERS = 1;
const DESIRED_FIGHTERS = 2;

function activeCreeps() {
    return getMyCreeps().filter(creep => !creep.spawning);
}

function isCombatCreep(creep) {
    return hasBodyPart(creep, ATTACK) ||
        hasBodyPart(creep, RANGED_ATTACK) ||
        hasBodyPart(creep, HEAL);
}

function roleOf(creep) {
    if (isCombatCreep(creep)) {
        return 'fighter';
    }
    if (hasBodyPart(creep, CARRY) && !hasBodyPart(creep, WORK)) {
        return 'refiller';
    }
    if (countBodyParts(creep, WORK) >= 2 && hasBodyPart(creep, CARRY)) {
        return 'builder';
    }
    if (hasBodyPart(creep, WORK) && hasBodyPart(creep, CARRY)) {
        return 'harvester';
    }
    return 'other';
}

function availableSpawnEnergy() {
    const structures = [
        ...getObjectsByPrototype(StructureSpawn),
        ...getObjectsByPrototype(StructureExtension),
    ].filter(structure => structure.my);
    return structures.reduce(
        (total, structure) => total + structure.store.getUsedCapacity(RESOURCE_ENERGY),
        0
    );
}

function chooseFighterBody(energy) {
    if (energy >= 600) {
        return [TOUGH, TOUGH, MOVE, MOVE, ATTACK, RANGED_ATTACK, HEAL];
    }
    if (energy >= 340) {
        return [TOUGH, MOVE, ATTACK, RANGED_ATTACK, MOVE];
    }
    if (energy >= 130) {
        return [MOVE, ATTACK];
    }
    return null;
}

function runSpawn(spawn, creeps, sites, enemies) {
    if (!spawn || spawn.spawning) {
        return;
    }

    const harvesters = creeps.filter(creep => roleOf(creep) === 'harvester');
    const refillers = creeps.filter(creep => roleOf(creep) === 'refiller');
    const builders = creeps.filter(creep => roleOf(creep) === 'builder');
    const fighters = creeps.filter(creep => roleOf(creep) === 'fighter');

    if (harvesters.length < DESIRED_HARVESTERS) {
        spawnIfNeeded(spawn, [WORK, CARRY, MOVE], harvesters.length, DESIRED_HARVESTERS);
        return;
    }
    if (refillers.length < DESIRED_REFILLERS) {
        spawnIfNeeded(spawn, [CARRY, CARRY, MOVE], refillers.length, DESIRED_REFILLERS);
        return;
    }
    if (sites.length > 0 && builders.length < 1) {
        spawnIfNeeded(spawn, [WORK, WORK, CARRY, MOVE, MOVE], builders.length, 1);
        return;
    }
    if (enemies.length > 0 && fighters.length < DESIRED_FIGHTERS) {
        const body = chooseFighterBody(availableSpawnEnergy());
        if (body) {
            spawnIfNeeded(spawn, body, fighters.length, DESIRED_FIGHTERS);
        }
    }
}

function spawningReceiver(creep) {
    const receivers = [
        ...getObjectsByPrototype(StructureSpawn),
        ...getObjectsByPrototype(StructureExtension),
    ].filter(structure => structure.my &&
        structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (receivers.length > 0) {
        return findClosestByRange(creep, receivers);
    }

    const towers = getObjectsByPrototype(StructureTower).filter(tower =>
        tower.my && tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    return towers.length > 0 ? findClosestByRange(creep, towers) : null;
}

function runHarvester(creep) {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        const source = getNearestActiveSource(creep);
        if (source) {
            harvestOrMove(creep, source);
        }
        return;
    }

    const receiver = spawningReceiver(creep);
    if (receiver) {
        transferOrMove(creep, receiver);
    }
}

function refillerReceiver(creep) {
    const extensions = getObjectsByPrototype(StructureExtension).filter(extension =>
        extension.my && extension.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (extensions.length > 0) {
        return findClosestByRange(creep, extensions);
    }

    const towers = getObjectsByPrototype(StructureTower).filter(tower =>
        tower.my && tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    return towers.length > 0 ? findClosestByRange(creep, towers) : null;
}

function runRefiller(creep) {
    const carried = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (carried > 0) {
        const target = refillerReceiver(creep) || spawningReceiver(creep);
        if (target) {
            transferOrMove(creep, target);
        }
        return;
    }

    const droppedEnergy = getObjectsByPrototype(Resource).filter(resource =>
        resource.resourceType === RESOURCE_ENERGY && resource.amount > 0);
    const dropped = droppedEnergy.length > 0 ? findClosestByRange(creep, droppedEnergy) : null;
    if (dropped) {
        const result = creep.pickup(dropped);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(dropped);
        }
        return;
    }

    // Withdraw only when there is somewhere useful to deliver the energy.
    const receiver = refillerReceiver(creep);
    const donors = getMySpawns().filter(spawn =>
        spawn.store.getUsedCapacity(RESOURCE_ENERGY) > 300 &&
        (!receiver || spawn.id !== receiver.id));
    const donor = receiver && donors.length > 0 ? findClosestByRange(creep, donors) : null;
    if (donor) {
        const result = creep.withdraw(donor, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(donor);
        }
    }
}

function runBuilder(creep, sites) {
    if (sites.length === 0) {
        runHarvester(creep);
        return;
    }
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        const source = getNearestActiveSource(creep);
        if (source) {
            harvestOrMove(creep, source);
        }
        return;
    }

    const site = findClosestByRange(creep, sites);
    if (site) {
        buildOrMove(creep, site);
    }
}

function dangerousEnemy(creep) {
    return hasBodyPart(creep, ATTACK) ||
        hasBodyPart(creep, RANGED_ATTACK) ||
        hasBodyPart(creep, HEAL);
}

function chooseCombatTarget(creep, enemies) {
    const dangerous = enemies.filter(dangerousEnemy);
    if (dangerous.length > 0) {
        return findClosestByRange(creep, dangerous);
    }

    const enemySpawns = getObjectsByPrototype(StructureSpawn).filter(spawn => spawn.my === false);
    if (enemySpawns.length > 0) {
        return findClosestByRange(creep, enemySpawns);
    }

    const enemyStructures = getObjectsByPrototype(Structure).filter(structure => structure.my === false);
    if (enemyStructures.length > 0) {
        return findClosestByRange(creep, enemyStructures);
    }

    return enemies.length > 0 ? findClosestByRange(creep, enemies) : null;
}

function runFighter(creep, friendlies, enemies) {
    if (hasBodyPart(creep, HEAL)) {
        if (creep.hits < creep.hitsMax) {
            creep.heal(creep);
        } else {
            const hurt = friendlies.filter(friend => friend.hits < friend.hitsMax);
            const patient = hurt.length > 0 ? findClosestByRange(creep, hurt) : null;
            if (patient && getRange(creep, patient) <= 1) {
                creep.heal(patient);
            } else if (patient && getRange(creep, patient) <= 3) {
                creep.rangedHeal(patient);
            }
        }
    }

    const target = chooseCombatTarget(creep, enemies);
    if (!target) {
        return;
    }

    const range = getRange(creep, target);
    if (hasBodyPart(creep, ATTACK) && range <= 1) {
        creep.attack(target);
    }
    if (hasBodyPart(creep, RANGED_ATTACK) && range <= 3) {
        creep.rangedAttack(target);
    }
    if ((hasBodyPart(creep, ATTACK) && range > 1) ||
        (!hasBodyPart(creep, ATTACK) && range > 3)) {
        creep.moveTo(target);
    }
}

function runTowers(friendlies, enemies) {
    for (const tower of getObjectsByPrototype(StructureTower).filter(structure => structure.my)) {
        if (tower.cooldown > 0) {
            continue;
        }

        const enemy = chooseCombatTarget(tower, enemies);
        if (enemy) {
            tower.attack(enemy);
            continue;
        }

        const hurt = friendlies.filter(creep => creep.hits < creep.hitsMax);
        const patient = hurt.length > 0 ? findClosestByRange(tower, hurt) : null;
        if (patient) {
            tower.heal(patient);
        }

        // Screeps Arena towers have no repair action. Unlike Screeps World,
        // damaged structures cannot be repaired by towers or creeps.
    }
}

export function loop() {
    const allMyCreeps = getMyCreeps();
    const friendlies = activeCreeps();
    const enemies = getEnemyCreeps();
    const sites = getObjectsByPrototype(ConstructionSite).filter(site => site.my);

    for (const spawn of getMySpawns()) {
        runSpawn(spawn, allMyCreeps, sites, enemies);
    }

    for (const creep of friendlies) {
        const role = roleOf(creep);
        if (role === 'harvester') {
            runHarvester(creep);
        } else if (role === 'refiller') {
            runRefiller(creep);
        } else if (role === 'builder') {
            runBuilder(creep, sites);
        } else if (role === 'fighter') {
            runFighter(creep, friendlies, enemies);
        }
    }

    runTowers(friendlies, enemies);
}
