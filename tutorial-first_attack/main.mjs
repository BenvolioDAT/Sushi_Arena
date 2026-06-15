import { getObjectsByPrototype, findClosestByRange, getRange } from 'game/utils';
import { Creep, Structure, StructureSpawn } from 'game/prototypes';
import { ATTACK, RANGED_ATTACK, HEAL } from 'game/constants';

function getMyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my);
}

function getEnemyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my === false);
}

function hasBodyPart(creep, partType) {
    return creep.body.some(part => part.type === partType && part.hits > 0);
}

function canFightOrHeal(creep) {
    return hasBodyPart(creep, ATTACK) ||
        hasBodyPart(creep, RANGED_ATTACK) ||
        hasBodyPart(creep, HEAL);
}

function chooseTarget(attacker) {
    const enemies = getEnemyCreeps();
    const dangerousCreeps = enemies.filter(canFightOrHeal);
    if (dangerousCreeps.length > 0) {
        return findClosestByRange(attacker, dangerousCreeps);
    }

    const hostileSpawns = getObjectsByPrototype(StructureSpawn).filter(spawn => spawn.my === false);
    if (hostileSpawns.length > 0) {
        return findClosestByRange(attacker, hostileSpawns);
    }

    const hostileStructures = getObjectsByPrototype(Structure).filter(structure => structure.my === false);
    if (hostileStructures.length > 0) {
        return findClosestByRange(attacker, hostileStructures);
    }

    return enemies.length > 0 ? findClosestByRange(attacker, enemies) : null;
}

function healIfPossible(creep, friendlies) {
    if (!hasBodyPart(creep, HEAL)) {
        return;
    }

    if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
        return;
    }

    const damaged = friendlies.filter(friend => friend.hits < friend.hitsMax);
    const target = damaged.length > 0 ? findClosestByRange(creep, damaged) : null;
    if (!target) {
        return;
    }

    if (getRange(creep, target) <= 1) {
        creep.heal(target);
    } else if (getRange(creep, target) <= 3) {
        creep.rangedHeal(target);
    }
}

export function loop() {
    const friendlies = getMyCreeps().filter(creep => !creep.spawning);
    const attacker = friendlies.find(creep =>
        hasBodyPart(creep, ATTACK) || hasBodyPart(creep, RANGED_ATTACK));
    if (!attacker) {
        return;
    }

    healIfPossible(attacker, friendlies);
    const target = chooseTarget(attacker);
    if (!target) {
        return;
    }

    const range = getRange(attacker, target);
    if (hasBodyPart(attacker, ATTACK) && range <= 1) {
        attacker.attack(target);
    }
    if (hasBodyPart(attacker, RANGED_ATTACK) && range <= 3) {
        attacker.rangedAttack(target);
    }
    if ((hasBodyPart(attacker, ATTACK) && range > 1) ||
        (!hasBodyPart(attacker, ATTACK) && range > 3)) {
        attacker.moveTo(target);
    }
}
