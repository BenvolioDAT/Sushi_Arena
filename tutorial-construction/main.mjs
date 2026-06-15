import {
    getObjectsByPrototype,
    findClosestByRange,
    createConstructionSite,
} from 'game/utils';
import {
    Creep,
    Source,
    StructureContainer,
    ConstructionSite,
    StructureTower,
} from 'game/prototypes';
import {
    RESOURCE_ENERGY,
    ERR_NOT_IN_RANGE,
} from 'game/constants';

const TOWER_POSITION = { x: 50, y: 55 };

function findTowerSite() {
    return getObjectsByPrototype(ConstructionSite).find(site =>
        site.my &&
        site.x === TOWER_POSITION.x &&
        site.y === TOWER_POSITION.y);
}

function towerIsFinished() {
    return getObjectsByPrototype(StructureTower).some(tower =>
        tower.my &&
        tower.x === TOWER_POSITION.x &&
        tower.y === TOWER_POSITION.y);
}

function createTowerSiteIfNeeded() {
    if (towerIsFinished()) {
        return null;
    }

    const existingSite = findTowerSite();
    if (existingSite) {
        return existingSite;
    }

    return createConstructionSite(TOWER_POSITION, StructureTower).object || null;
}

function getEnergy(creep) {
    const sources = getObjectsByPrototype(Source).filter(source => source.energy > 0);
    const containers = getObjectsByPrototype(StructureContainer).filter(container =>
        container.store.getUsedCapacity(RESOURCE_ENERGY) > 0);

    const source = sources.length > 0 ? findClosestByRange(creep, sources) : null;
    const container = containers.length > 0
        ? findClosestByRange(creep, containers)
        : null;

    // This works whether the tutorial provides a harvestable source or a
    // container as its energy supply.
    if (source && (!container || creep.getRangeTo(source) <= creep.getRangeTo(container))) {
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source);
        }
    } else if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(container);
        }
    }
}

export function loop() {
    const worker = getObjectsByPrototype(Creep).find(creep =>
        creep.my && !creep.spawning);
    const site = createTowerSiteIfNeeded();

    if (!worker || towerIsFinished()) {
        return;
    }

    if (worker.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        getEnergy(worker);
        return;
    }

    if (site && worker.build(site) === ERR_NOT_IN_RANGE) {
        worker.moveTo(site);
    }
}
