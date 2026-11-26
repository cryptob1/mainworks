const { ChildProcess } = require('node:child_process');

// GY-3922, GY-3931: Node's test runner spawns each test file with a piped stdin socket it never
// closes, so a read of stdin in a test blocks until the file bound. Closing fd 0 inside the child
// with closeSync(0) + openSync('/dev/null', 'r') left fd 0 unassigned between the two calls, so a
// concurrent libuv handle could claim fd 0 and abort on uv__close (`fd > STDERR_FILENO`).
// Setting stdio[0] to 'ignore' when the runner spawns the child binds fd 0 to /dev/null at execve
// time instead, while keeping full per-file process isolation.
if (!process.env.NODE_TEST_CONTEXT) {
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    if (options?.envPairs?.some(entry => entry.startsWith('NODE_TEST_CONTEXT='))) {
      const stdio = Array.isArray(options.stdio) ? ['ignore', ...options.stdio.slice(1)] : ['ignore', 'pipe', 'pipe'];
      options = { ...options, stdio };
    }
    return spawn.call(this, options);
  };
}
