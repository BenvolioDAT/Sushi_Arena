import { getObjectsByPrototype, findClosestByRange, getRange } from 'game/utils';
import { Creep } from 'game/prototypes';
import {
    ATTACK,
    RANGED_ATTACK,
    HEAL,
    ERR_NOT_IN_RANGE,
} from 'game/constants';

function hasActiveBodyPart(creep, partType) {
    return creep.body.some(part => part.type === partType && part.hits > 0);
}

function chooseTarget(fighters, enemies) {
    if (enemies.length === 0) {
        return null;
    }

    // All damage dealers focus the same enemy so it stops dealing damage sooner.
    const leader = fighters[0];
    return leader ? findClosestByRange(leader, enemies) : enemies[0];
}

function runMelee(creep, target) {
    if (!creep || !target) {
        return;
    }

    if (creep.attack(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
}

function runRanged(creep, target) {
    if (!creep || !target) {
        return;
    }

    if (creep.rangedAttack(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
}

function choosePatient(healer, friendlies) {
    const damaged = friendlies.filter(creep => creep.hits < creep.hitsMax);
    if (damaged.length === 0) {
        return null;
    }

    // Heal the creep missing the most hit points first.
    damaged.sort((a, b) =>
        (b.hitsMax - b.hits) - (a.hitsMax - a.hits));

    const mostDamagedAmount = damaged[0].hitsMax - damaged[0].hits;
    const mostDamaged = damaged.filter(creep =>
        creep.hitsMax - creep.hits === mostDamagedAmount);
    return findClosestByRange(healer, mostDamaged);
}

function runHealer(healer, friendlies, fighters) {
    if (!healer) {
        return;
    }

    const patient = choosePatient(healer, friendlies);
    if (patient) {
        if (healer.heal(patient) === ERR_NOT_IN_RANGE) {
            healer.moveTo(patient);
        }
        return;
    }

    // Stay close enough to heal immediately when a fighter takes damage.
    const escort = fighters[0];
    if (escort && getRange(healer, escort) > 1) {
        healer.moveTo(escort);
    }
}

export function loop() {
    const allCreeps = getObjectsByPrototype(Creep);
    const friendlies = allCreeps.filter(creep => creep.my && !creep.spawning);
    const enemies = allCreeps.filter(creep => creep.my === false);

    const meleeCreeps = friendlies.filter(creep => hasActiveBodyPart(creep, ATTACK));
    const rangedCreeps = friendlies.filter(creep =>
        hasActiveBodyPart(creep, RANGED_ATTACK));
    const healers = friendlies.filter(creep =>
        hasActiveBodyPart(creep, HEAL) &&
        !hasActiveBodyPart(creep, ATTACK) &&
        !hasActiveBodyPart(creep, RANGED_ATTACK));
    const fighters = [...meleeCreeps, ...rangedCreeps];
    const target = chooseTarget(fighters, enemies);

    for (const creep of meleeCreeps) {
        runMelee(creep, target);
    }
    for (const creep of rangedCreeps) {
        runRanged(creep, target);
    }
    for (const healer of healers) {
        runHealer(healer, friendlies, fighters);
    }
}
