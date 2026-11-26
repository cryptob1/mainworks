import { closeSync, openSync } from 'node:fs';

// GY-3922: Node's test runner hands each test file a stdin socket it never closes, so a read of
// stdin in a test (GY-3914's e2e trial script, run in-process by the hard-math fixture) waited for
// the 300 s file bound. Every test file process reads end of input instead: /dev/null takes fd 0.
closeSync(0);
openSync('/dev/null', 'r');
