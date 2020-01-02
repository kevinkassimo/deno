import { ConnServer } from "../server.ts";
import { TCPConn } from "../../net/tcp.ts";

const body = new TextEncoder().encode("Hello World");
const s = new ConnServer();

onmessage = (e) => {
  const data: any = e.data;
  s.addConn(new TCPConn(data.rid, data.remoteAddr, data.localAddr));
};

for await (const req of s) {
  const res = {
    body,
    headers: new Headers()
  };
  res.headers.set("Date", new Date().toUTCString());
  res.headers.set("Connection", "keep-alive");
  req.respond(res).catch(() => {});
}
