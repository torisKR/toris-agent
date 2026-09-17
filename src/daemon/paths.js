import { join } from 'node:path';

/**
 * On-disk layout for the local daemon. All paths live under the same
 * `$TORIS_HOME` (default `~/.toris`) that the rest of the CLI already owns.
 * There is no remote home and no extra config file.
 */
export function daemonPaths(home) {
  return {
    home,
    lock: join(home, 'daemon.lock'),
    state: join(home, 'daemon.json'),
    inbox: join(home, 'daemon', 'inbox'),
    schedules: join(home, 'daemon', 'schedules'),
    jobs: join(home, 'daemon-jobs.json'),
    log: join(home, 'logs', 'daemon.log'),
  };
}
