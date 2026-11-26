import { closeSync, openSync } from 'node:fs';

// GY-3922: Node's test runner hands each test file a stdin socket it never closes, so a read of
// stdin in a test (GY-3914's e2e trial script, run in-process by the hard-math fixture) waited for
// the 300 s file bound. Every test file process reads end of input instead: /dev/null takes fd 0.
// GY-3930: preloaded with --require, before any --import starts tsx's loader thread: a file that thread
// opened between the close and the open took fd 0, and a later child's pipe on fd 0 aborted the process.
closeSync(0);
openSync('/dev/null', 'r');
