export class TCPConn implements Deno.Conn {
  constructor(
    readonly rid: number,
    readonly remoteAddr: string,
    readonly localAddr: string
  ) {}
  write(p: Uint8Array): Promise<number> {
    return Deno.write(this.rid, p);
  }
  read(p: Uint8Array): Promise<number | Deno.EOF> {
    return Deno.read(this.rid, p);
  }
  close(): void {
    Deno.close(this.rid);
  }
  closeRead(): void {
    // @ts-ignore
    Deno.shutdown(this.rid, Deno.ShutdownMode.Read);
  }
  closeWrite(): void {
    // @ts-ignore
    Deno.shutdown(this.rid, Deno.ShutdownMode.Write);
  }
}
