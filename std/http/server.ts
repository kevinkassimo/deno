// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
const { listen, listenTLS, copy, toAsyncIterator } = Deno;
type Listener = Deno.Listener;
type Conn = Deno.Conn;
type Reader = Deno.Reader;
type Writer = Deno.Writer;
import { BufReader, BufWriter, UnexpectedEOFError } from "../io/bufio.ts";
import { TextProtoReader } from "../textproto/mod.ts";
import { STATUS_TEXT } from "./http_status.ts";
import { assert } from "../testing/asserts.ts";
import {
  collectUint8Arrays,
  consumeAsyncIterable,
  deferred,
  Deferred,
  MuxAsyncIterator
} from "../util/async.ts";

function bufWriter(w: Writer): BufWriter {
  if (w instanceof BufWriter) {
    return w;
  } else {
    return new BufWriter(w);
  }
}

export function setContentLength(r: Response): void {
  if (!r.headers) {
    r.headers = new Headers();
  }

  if (r.body) {
    if (!r.headers.has("content-length")) {
      if (r.body instanceof Uint8Array) {
        const bodyLength = r.body.byteLength;
        r.headers.append("Content-Length", bodyLength.toString());
      } else {
        r.headers.append("Transfer-Encoding", "chunked");
      }
    }
  }
}

async function writeChunkedBody(w: Writer, r: Reader): Promise<void> {
  const writer = bufWriter(w);
  const encoder = new TextEncoder();

  for await (const chunk of toAsyncIterator(r)) {
    if (chunk.byteLength <= 0) continue;
    const start = encoder.encode(`${chunk.byteLength.toString(16)}\r\n`);
    const end = encoder.encode("\r\n");
    await writer.write(start);
    await writer.write(chunk);
    await writer.write(end);
  }

  const endChunk = encoder.encode("0\r\n\r\n");
  await writer.write(endChunk);
}

export async function writeResponse(w: Writer, r: Response): Promise<void> {
  const protoMajor = 1;
  const protoMinor = 1;
  const statusCode = r.status || 200;
  const statusText = STATUS_TEXT.get(statusCode);
  const writer = bufWriter(w);
  if (!statusText) {
    throw Error("bad status code");
  }
  if (!r.body) {
    r.body = new Uint8Array();
  }

  let out = `HTTP/${protoMajor}.${protoMinor} ${statusCode} ${statusText}\r\n`;

  setContentLength(r);
  const headers = r.headers!;

  for (const [key, value] of headers!) {
    out += `${key}: ${value}\r\n`;
  }
  out += "\r\n";

  const header = new TextEncoder().encode(out);
  const n = await writer.write(header);
  assert(n === header.byteLength);

  if (r.body instanceof Uint8Array) {
    const n = await writer.write(r.body);
    assert(n === r.body.byteLength);
  } else if (headers.has("content-length")) {
    const bodyLength = parseInt(headers.get("content-length")!);
    const n = await copy(writer, r.body);
    assert(n === bodyLength);
  } else {
    await writeChunkedBody(writer, r.body);
  }
  await writer.flush();
}

export class ServerRequest implements Deno.Reader {
  url!: string;
  method!: string;
  proto!: string;
  protoMinor!: number;
  protoMajor!: number;
  headers!: Headers;
  conn!: Conn;
  r!: BufReader;
  w!: BufWriter;
  done: Deferred<Error | undefined> = deferred();

  static DEFAULT_BUF_SIZE = 1024;

  private _streamIterator: AsyncIterableIterator<number>;
  private _readBuffer = new Uint8Array(0);

  private _contentLength: number | undefined | null = undefined;
  /**
   * Value of Content-Length header.
   * If null, then content length is invalid or not given (e.g. chunked encoding).
   */
  get contentLength(): number | null {
    // undefined means not cached.
    // null means invalid or not provided.
    if (this._contentLength === undefined) {
      if (this.headers.has("content-length")) {
        this._contentLength = +this.headers.get("content-length")!;
        // Convert NaN to null (as NaN harder to test)
        if (Number.isNaN(this._contentLength)) {
          this._contentLength = null;
        }
      } else {
        this._contentLength = null;
      }
    }
    return this._contentLength;
  }

  /**
   * Internal: actually reading body. Each step, fills this._readBuffer
   * from start. Yields size read into the buffer each step.
   * Returns on no more data to read or error.
   */
  private async *_bodyStream(): AsyncIterableIterator<number> {
    if (this.headers.has("content-length")) {
      const len = this.contentLength;
      if (len === null) {
        return;
      }
      let rr = await this.r.read(this._readBuffer);
      let nread = rr === Deno.EOF ? 0 : rr;
      let nreadTotal = nread;
      while (rr !== Deno.EOF && nreadTotal < len) {
        yield nread;
        rr = await this.r.read(this._readBuffer);
        nread = rr === Deno.EOF ? 0 : rr;
        nreadTotal += nread;
      }
      yield nread;
    } else {
      if (this.headers.has("transfer-encoding")) {
        const transferEncodings = this.headers
          .get("transfer-encoding")!
          .split(",")
          .map((e): string => e.trim().toLowerCase());
        if (transferEncodings.includes("chunked")) {
          // Based on https://tools.ietf.org/html/rfc2616#section-19.4.6
          const tp = new TextProtoReader(this.r);
          let line = await tp.readLine();
          if (line === Deno.EOF) throw new UnexpectedEOFError();
          // TODO: handle chunk extension
          const [chunkSizeString] = line.split(";");
          let chunkSize = parseInt(chunkSizeString, 16);
          if (Number.isNaN(chunkSize) || chunkSize < 0) {
            throw new Error("Invalid chunk size");
          }
          while (chunkSize > 0) {
            let currChunkOffset = 0;
            // Since given readBuffer might be smaller, loop.
            while (currChunkOffset < chunkSize) {
              // Try to be as large as chunkSize. Might be smaller though.
              const bufferToFill = this._readBuffer.subarray(0, chunkSize);
              if ((await this.r.readFull(bufferToFill)) === Deno.EOF) {
                throw new UnexpectedEOFError();
              }
              currChunkOffset += bufferToFill.length;
              yield bufferToFill.length;
            }
            await this.r.readLine(); // Consume \r\n
            line = await tp.readLine();
            if (line === Deno.EOF) throw new UnexpectedEOFError();
            chunkSize = parseInt(line, 16);
          }
          const entityHeaders = await tp.readMIMEHeader();
          if (entityHeaders !== Deno.EOF) {
            for (const [k, v] of entityHeaders) {
              this.headers.set(k, v);
            }
          }
          /* Pseudo code from https://tools.ietf.org/html/rfc2616#section-19.4.6
          length := 0
          read chunk-size, chunk-extension (if any) and CRLF
          while (chunk-size > 0) {
            read chunk-data and CRLF
            append chunk-data to entity-body
            length := length + chunk-size
            read chunk-size and CRLF
          }
          read entity-header
          while (entity-header not empty) {
            append entity-header to existing header fields
            read entity-header
          }
          Content-Length := length
          Remove "chunked" from Transfer-Encoding
          */
          return; // Must return here to avoid fall through
        }
        // TODO: handle other transfer-encoding types
      }
      // Otherwise... Do nothing
    }
  }

  /**
   * Read the request body as a stream.
   * Currently, it can only handle basic body with content length,
   * or `Transfer-Encoding: chunked`.
   * @param bufferToReuse If provided, buffer to reuse for new data.
   *   (actually returned buffer is a subarray of given buffer).
   *   Returned buffer will be overwritten on next().
   * @param bufferToFill If provided, buffer to fully filled.
   *   Requires Content-Length header valid and buffer larger than it.
   */
  public async *bodyStream(
    bufferToReuse?: Uint8Array,
    bufferToFill?: Uint8Array
  ): AsyncIterableIterator<Uint8Array> {
    if (this._streamIterator) {
      throw new Error("Stream has already been read");
    }
    const len = this.contentLength;
    const hasLen = len !== null;
    if (bufferToReuse) {
      assert(bufferToReuse.length > 0, "Reused buffer size cannot be 0");
      this._readBuffer = bufferToReuse;
      this._streamIterator = this._bodyStream();
      for await (const size of this._streamIterator) {
        yield this._readBuffer.subarray(0, size);
        // _readBuffer would be reused from start when continue.
      }
    } else if (bufferToFill) {
      assert(hasLen, "Cannot fill buffer under unknown content length");
      assert(bufferToFill.length >= len!, "Buffer to fill is too small");
      this._readBuffer = bufferToFill;
      this._streamIterator = this._bodyStream();
      for await (const size of this._streamIterator) {
        yield this._readBuffer.subarray(0, size);
        // _readBuffer is shrinked for remaining.
        this._readBuffer = this._readBuffer.subarray(size);
      }
    } else {
      // No reuse, allocate new buffer every single time.
      let offset = 0;
      this._readBuffer = new Uint8Array(
        hasLen
          ? Math.min(ServerRequest.DEFAULT_BUF_SIZE, len)
          : ServerRequest.DEFAULT_BUF_SIZE
      );
      this._streamIterator = this._bodyStream();
      for await (const size of this._streamIterator) {
        yield this._readBuffer.subarray(0, size);
        offset += size;
        this._readBuffer = new Uint8Array(
          hasLen
            ? Math.min(ServerRequest.DEFAULT_BUF_SIZE, len - offset)
            : ServerRequest.DEFAULT_BUF_SIZE
        );
      }
    }
  }

  /**
   * Read a chunk of the request body into given buffer.
   * You should NOT call `.read()` if `.bodyStream()` or `.body()` is called.
   * @param p Buffer to write into.
   * @returns Read result.
   */
  public async read(p: Uint8Array): Promise<number | Deno.EOF> {
    if (!this._streamIterator) {
      this._streamIterator = this._bodyStream();
    }
    // Set internal buffer to the one user provided.
    this._readBuffer = p;
    const { value, done } = await this._streamIterator.next();
    if (done) {
      return Deno.EOF;
    }
    return value;
  }

  /**
   * Read the body of the request into a single Uint8Array.
   * Internally iterates through `.bodyStream()`.
   * @returns Buffer containing body data.
   */
  public async body(): Promise<Uint8Array> {
    if (this._streamIterator) {
      throw new Error("Stream has already been read");
    }
    if (this.contentLength !== null) {
      // Content-Length is given.
      // Pre-allocate buffer (we need to return anyways) to avoid copy.
      const outputBuffer = new Uint8Array(this.contentLength);
      // Discard results, since outputBuffer will be filled.
      await consumeAsyncIterable(this.bodyStream(undefined, outputBuffer));
      return outputBuffer;
    } else {
      // Without predetermined length. Fallback to copy implementation.
      return collectUint8Arrays(this.bodyStream());
    }
  }

  async respond(r: Response): Promise<void> {
    let err: Error | undefined;
    try {
      // Write our response!
      await writeResponse(this.w, r);
    } catch (e) {
      try {
        // Eagerly close on error.
        this.conn.close();
      } catch {}
      err = e;
    }
    // Signal that this request has been processed and the next pipelined
    // request on the same connection can be accepted.
    this.done.resolve(err);
    if (err) {
      // Error during responding, rethrow.
      throw err;
    }
  }
}

function fixLength(req: ServerRequest): void {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength) {
    const arrClen = contentLength.split(",");
    if (arrClen.length > 1) {
      const distinct = [...new Set(arrClen.map((e): string => e.trim()))];
      if (distinct.length > 1) {
        throw Error("cannot contain multiple Content-Length headers");
      } else {
        req.headers.set("Content-Length", distinct[0]);
      }
    }
    const c = req.headers.get("Content-Length");
    if (req.method === "HEAD" && c && c !== "0") {
      throw Error("http: method cannot contain a Content-Length");
    }
    if (c && req.headers.has("transfer-encoding")) {
      // A sender MUST NOT send a Content-Length header field in any message
      // that contains a Transfer-Encoding header field.
      // rfc: https://tools.ietf.org/html/rfc7230#section-3.3.2
      throw new Error(
        "http: Transfer-Encoding and Content-Length cannot be send together"
      );
    }
  }
}

/**
 * ParseHTTPVersion parses a HTTP version string.
 * "HTTP/1.0" returns (1, 0, true).
 * Ported from https://github.com/golang/go/blob/f5c43b9/src/net/http/request.go#L766-L792
 */
export function parseHTTPVersion(vers: string): [number, number] {
  switch (vers) {
    case "HTTP/1.1":
      return [1, 1];

    case "HTTP/1.0":
      return [1, 0];

    default: {
      const Big = 1000000; // arbitrary upper bound
      const digitReg = /^\d+$/; // test if string is only digit

      if (!vers.startsWith("HTTP/")) {
        break;
      }

      const dot = vers.indexOf(".");
      if (dot < 0) {
        break;
      }

      const majorStr = vers.substring(vers.indexOf("/") + 1, dot);
      const major = parseInt(majorStr);
      if (
        !digitReg.test(majorStr) ||
        isNaN(major) ||
        major < 0 ||
        major > Big
      ) {
        break;
      }

      const minorStr = vers.substring(dot + 1);
      const minor = parseInt(minorStr);
      if (
        !digitReg.test(minorStr) ||
        isNaN(minor) ||
        minor < 0 ||
        minor > Big
      ) {
        break;
      }

      return [major, minor];
    }
  }

  throw new Error(`malformed HTTP version ${vers}`);
}

export async function readRequest(
  conn: Conn,
  bufr: BufReader
): Promise<ServerRequest | Deno.EOF> {
  const tp = new TextProtoReader(bufr);
  const firstLine = await tp.readLine(); // e.g. GET /index.html HTTP/1.0
  if (firstLine === Deno.EOF) return Deno.EOF;
  const headers = await tp.readMIMEHeader();
  if (headers === Deno.EOF) throw new UnexpectedEOFError();

  const req = new ServerRequest();
  req.conn = conn;
  req.r = bufr;
  [req.method, req.url, req.proto] = firstLine.split(" ", 3);
  [req.protoMinor, req.protoMajor] = parseHTTPVersion(req.proto);
  req.headers = headers;
  fixLength(req);
  return req;
}

export class Server implements AsyncIterable<ServerRequest> {
  private closing = false;

  constructor(public listener: Listener) {}

  close(): void {
    this.closing = true;
    this.listener.close();
  }

  // Yields all HTTP requests on a single TCP connection.
  private async *iterateHttpRequests(
    conn: Conn
  ): AsyncIterableIterator<ServerRequest> {
    const bufr = new BufReader(conn);
    const w = new BufWriter(conn);
    let req: ServerRequest | Deno.EOF;
    let err: Error | undefined;

    while (!this.closing) {
      try {
        req = await readRequest(conn, bufr);
      } catch (e) {
        err = e;
        break;
      }
      if (req === Deno.EOF) {
        break;
      }

      req.w = w;
      yield req;

      // Wait for the request to be processed before we accept a new request on
      // this connection.
      const procError = await req!.done;
      if (procError) {
        // Something bad happened during response.
        // (likely other side closed during pipelined req)
        // req.done implies this connection already closed, so we can just return.
        return;
      }
    }

    if (req! === Deno.EOF) {
      // The connection was gracefully closed.
    } else if (err) {
      // An error was thrown while parsing request headers.
      try {
        await writeResponse(req!.w, {
          status: 400,
          body: new TextEncoder().encode(`${err.message}\r\n\r\n`)
        });
      } catch (_) {
        // The connection is destroyed.
        // Ignores the error.
      }
    } else if (this.closing) {
      // There are more requests incoming but the server is closing.
      // TODO(ry): send a back a HTTP 503 Service Unavailable status.
    }

    conn.close();
  }

  // Accepts a new TCP connection and yields all HTTP requests that arrive on
  // it. When a connection is accepted, it also creates a new iterator of the
  // same kind and adds it to the request multiplexer so that another TCP
  // connection can be accepted.
  private async *acceptConnAndIterateHttpRequests(
    mux: MuxAsyncIterator<ServerRequest>
  ): AsyncIterableIterator<ServerRequest> {
    if (this.closing) return;
    // Wait for a new connection.
    const { value, done } = await this.listener.next();
    if (done) return;
    const conn = value as Conn;
    // Try to accept another connection and add it to the multiplexer.
    mux.add(this.acceptConnAndIterateHttpRequests(mux));
    // Yield the requests that arrive on the just-accepted connection.
    yield* this.iterateHttpRequests(conn);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ServerRequest> {
    const mux: MuxAsyncIterator<ServerRequest> = new MuxAsyncIterator();
    mux.add(this.acceptConnAndIterateHttpRequests(mux));
    return mux.iterate();
  }
}

interface ServerConfig {
  port: number;
  hostname?: string;
}

/**
 * Start a HTTP server
 *
 *     import { serve } from "https://deno.land/std/http/server.ts";
 *     const body = new TextEncoder().encode("Hello World\n");
 *     const s = serve({ port: 8000 });
 *     for await (const req of s) {
 *       req.respond({ body });
 *     }
 */
export function serve(addr: string | ServerConfig): Server {
  if (typeof addr === "string") {
    const [hostname, port] = addr.split(":");
    addr = { hostname, port: Number(port) };
  }

  const listener = listen(addr);
  return new Server(listener);
}

export async function listenAndServe(
  addr: string,
  handler: (req: ServerRequest) => void
): Promise<void> {
  const server = serve(addr);

  for await (const request of server) {
    handler(request);
  }
}

/** Options for creating an HTTPS server. */
export type HTTPSOptions = Omit<Deno.ListenTLSOptions, "transport">;

/**
 * Create an HTTPS server with given options
 *
 *     const body = new TextEncoder().encode("Hello HTTPS");
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     for await (const req of serveTLS(options)) {
 *       req.respond({ body });
 *     }
 *
 * @param options Server configuration
 * @return Async iterable server instance for incoming requests
 */
export function serveTLS(options: HTTPSOptions): Server {
  const tlsOptions: Deno.ListenTLSOptions = {
    ...options,
    transport: "tcp"
  };
  const listener = listenTLS(tlsOptions);
  return new Server(listener);
}

/**
 * Create an HTTPS server with given options and request handler
 *
 *     const body = new TextEncoder().encode("Hello HTTPS");
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     listenAndServeTLS(options, (req) => {
 *       req.respond({ body });
 *     });
 *
 * @param options Server configuration
 * @param handler Request handler
 */
export async function listenAndServeTLS(
  options: HTTPSOptions,
  handler: (req: ServerRequest) => void
): Promise<void> {
  const server = serveTLS(options);

  for await (const request of server) {
    handler(request);
  }
}

export interface Response {
  status?: number;
  headers?: Headers;
  body?: Uint8Array | Reader;
}
