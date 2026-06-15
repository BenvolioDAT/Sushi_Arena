import { getObjectsByPrototype, findClosestByRange } from 'game/utils';
import {
    Creep,
    StructureContainer,
    StructureTower,
} from 'game/prototypes';
import {
    RESOURCE_ENERGY,
    ERR_NOT_IN_RANGE,
} from 'game/constants';

function runTower(tower, enemies) {
    if (!tower || enemies.length === 0) {
        return;
    }

    const target = findClosestByRange(tower, enemies);
    if (target) {
        tower.attack(target);
    }
}

function runEnergyCreep(creep, container, tower) {
    if (!creep || !container || !tower) {
        return;
    }

    const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

    if (carriedEnergy === 0) {
        const result = creep.withdraw(container, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(container);
        }
        return;
    }

    const result = creep.transfer(tower, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(tower);
    }
}

export function loop() {
    const creeps = getObjectsByPrototype(Creep);
    const myCreep = creeps.find(creep => creep.my && !creep.spawning);
    const enemies = creeps.filter(creep => creep.my === false);
    const container = getObjectsByPrototype(StructureContainer)[0];
    const tower = getObjectsByPrototype(StructureTower).find(structure => structure.my);

    runTower(tower, enemies);
    runEnergyCreep(myCreep, container, tower);
}
