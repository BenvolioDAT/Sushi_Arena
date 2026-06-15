import { getObjectsByPrototype, findClosestByRange } from 'game/utils';
import { Creep, Source, StructureSpawn } from 'game/prototypes';
import { RESOURCE_ENERGY, ERR_NOT_IN_RANGE } from 'game/constants';

function getMyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my);
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

export function loop() {
    const creep = getMyCreeps().find(unit => !unit.spawning);
    const spawn = getObjectsByPrototype(StructureSpawn).find(structure => structure.my);
    if (!creep || !spawn) {
        return;
    }

    const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    const freeCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    if (carriedEnergy > 0 && freeCapacity === 0) {
        const result = creep.transfer(spawn, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(spawn);
        }
        return;
    }

    if (freeCapacity > 0) {
        const source = getNearestActiveSource(creep);
        if (source) {
            harvestOrMove(creep, source);
        }
        return;
    }

    const result = creep.transfer(spawn, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawn);
    }
}
