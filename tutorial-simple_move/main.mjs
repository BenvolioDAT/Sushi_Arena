import { getObjectsByPrototype, findClosestByRange } from 'game/utils';
import { Creep, Flag } from 'game/prototypes';

// Change this fallback if a version of the tutorial uses a fixed destination.
const TARGET_POSITION = { x: 50, y: 50 };

export function loop() {
    const creep = getObjectsByPrototype(Creep).find(unit => unit.my && !unit.spawning);
    if (!creep) {
        return;
    }

    const objectiveFlags = getObjectsByPrototype(Flag).filter(flag => flag.my !== true);
    const target = objectiveFlags.length > 0
        ? findClosestByRange(creep, objectiveFlags)
        : TARGET_POSITION;

    if (target) {
        creep.moveTo(target);
    }
}
