import { getObjectsByPrototype } from 'game/utils';
import { Creep, Flag } from 'game/prototypes';

export function loop() {
    const creeps = getObjectsByPrototype(Creep).filter(creep =>
        creep.my && !creep.spawning);
    const flags = getObjectsByPrototype(Flag);

    if (flags.length === 0) {
        return;
    }

    for (const creep of creeps) {
        // Path distance matters here because walls and swamps can make the
        // nearest flag by straight-line range the wrong destination.
        const closestFlag = creep.findClosestByPath(flags);
        if (closestFlag) {
            creep.moveTo(closestFlag);
        }
    }
}
