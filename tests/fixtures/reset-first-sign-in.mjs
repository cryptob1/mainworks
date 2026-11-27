// GY-3997 test seam: once this process is a Playwright worker (it sets TEST_WORKER_INDEX as it starts), the first
// POST /api/sign-in any HTTP server here receives has its connection dropped before the handler runs, as a reused
// keep-alive connection the server had just closed is. The client reads it as ECONNRESET; nothing was redeemed.
import http from 'node:http';

const emit = http.Server.prototype.emit;
let dropped = false;
http.Server.prototype.emit = function (event, request, ...rest) {
  if (event === 'request' && !dropped && process.env.TEST_WORKER_INDEX !== undefined && request.method === 'POST' && request.url === '/api/sign-in') {
    dropped = true;
    request.socket.destroy();
    return true;
  }
  return emit.call(this, event, request, ...rest);
};
