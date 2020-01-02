const NUM_WORKERS = 2;
const workerPool = [];
for (let i = 0; i < NUM_WORKERS; i++) {
  workerPool.push(new Worker("./conn_worker.ts", {
    shareResources: true,
  }));
}
let nextWorkerId = 0;

const l = Deno.listen({ port: 4500 });
while (true) {
  const conn = await l.accept();
  workerPool[nextWorkerId].postMessage({ rid: conn.rid, remoteAddr: conn.remoteAddr, localAddr: conn.localAddr });
  nextWorkerId = (nextWorkerId + 1) % NUM_WORKERS;
}
