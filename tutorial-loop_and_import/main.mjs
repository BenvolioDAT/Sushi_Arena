import { arenaInfo } from 'game';
import { getTicks } from 'game/utils';

export function loop() {
    const tick = getTicks();

    // Logging every 10 ticks keeps the console useful without flooding it.
    if (tick % 10 === 0) {
        console.log(
            `tick=${tick} arena=${arenaInfo.name} level=${arenaInfo.level} ` +
            `season=${arenaInfo.season} limit=${arenaInfo.ticksLimit}`
        );
    }
}
