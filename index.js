const express = require("express");
const bodyParser = require("body-parser");
const SocketIO = require("socket.io");
const ioClient = require("socket.io-client");
const http = require("http");
const axios = require("axios");
const md5 = require("md5");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { mkdirSync, writeFileSync, readFileSync } = require("fs");
const { dirname } = require("path");

const SNAPSHOT_DIR = "__mock-server-snapshots__";
const port = process.env.PORT || 9001;

class MockServer {
  constructor(logAll) {
    this.app = express();
    this.server = http.Server(this.app);
    this.io = SocketIO(this.server, { transports: ["websocket"] });
    this.logAll = logAll;
  }

  async start() {
    this.app.use(bodyParser.urlencoded({ extended: true }));
    this.app.use(bodyParser.json());

    this.app.all("/", (req, res) => {
      if (req.url.indexOf("/?url=") !== -1) {
        [, req.url] = req.url.split("/?url=");
      }

      this.serveHttpData(req, res);
    });

    this.app.all("/*", async (req, res) => {
      const url = req.url.substring(1);
      this.serveHttpData({ ...req, url }, res);
    });

    this.io.on("connection", socket => {
      const { url } = socket.handshake.query;

      if (!url) {
        this.log("[socket.io] a client tried to connect with blank url...");
        socket.disconnect();
      }

      const { href, host } = new URL(decodeURIComponent(url));
      this.log(`[socket.io] a client connected proxying ${url}`);

      socket.on("message", async (data, callback) => {
        this.log(`[socket.io] received message from client proxying ${url}`);

        const requestData = {
          host,
          href,
          data,
          pathname: "/socket.io/",
          method: "websocket"
        };

        const { data: response } = await this.recordReplaySocketIO(requestData);
        this.log(`[socket.io] sending response to client proxying ${url}`);
        callback(JSON.parse(response));
      });
    });

    this.server.listen(port);
    this.log(`[server] mock server listening on port ${port}`, true);
  }

  close() {
    this.server.close();
    this.io.close();

    return new Promise(resolve => {
      setTimeout(() => {
        this.log("[server] mock server closed", true);
        return resolve();
      }, 5000);
    });
  }

  log(message, force) {
    if (this.logAll || force) {
      console.log(message);
    }
  }

  getSnapshotFiles(requestData) {
    const { host, pathname, method } = requestData;
    const uniqueReqId = md5(JSON.stringify(requestData));

    const snapshotBase = `${SNAPSHOT_DIR}/${host}${
      pathname.slice(-1) === "/" ? `${pathname}index` : pathname
    }.${method}.${uniqueReqId}`;

    return {
      directory: dirname(snapshotBase),
      info: `${snapshotBase}.json`,
      data: `${snapshotBase}.data`
    };
  }

  fetchFromSnapshot(requestData) {
    const { href } = requestData;

    try {
      const snapshotFiles = this.getSnapshotFiles(requestData);

      const info = JSON.parse(readFileSync(snapshotFiles.info));
      const data = readFileSync(snapshotFiles.data);

      this.log(`[snapshot] fetched snapshot from ${snapshotFiles.info}`);

      const snapshotData = { info, data, requestData };
      return snapshotData;
    } catch (err) {
      this.log(
        `[warning] no snapshot file found for path ${href} fetching from remote`
      );
    }
  }

  saveSnapshot({ data, info, requestData }) {
    const snapshotFiles = this.getSnapshotFiles(requestData);

    mkdirSync(snapshotFiles.directory, { recursive: true });

    writeFileSync(snapshotFiles.info, JSON.stringify(info));
    writeFileSync(snapshotFiles.data, Buffer.from(data, "binary"));

    this.log(`[snapshot] saved snapshot to ${snapshotFiles.info}`);
  }

  async fetchFromServer(requestData) {
    const { href, method, headers, body } = requestData;
    try {
      const options = {
        url: href,
        method,
        headers,
        data: body,
        responseType: "arraybuffer"
      };

      const { data, ...info } = await axios(options);
      delete info.request;
      const snapshotData = { data, info, requestData };

      this.log(`[http] fetched data from ${href}`);
      this.saveSnapshot(snapshotData);
      return snapshotData;
    } catch (err) {
      this.log(err);
    }
  }

  async recordReplayData(req) {
    const { url, method, headers: fullHeaders, body } = req;

    const headers = ["Content-Type", "user-agent", "Authorization"].reduce(
      (o, k) => {
        if (!fullHeaders[k]) {
          return o;
        }

        return {
          ...o,
          [k]: fullHeaders[k]
        };
      },
      {}
    );

    const { href, host, pathname } = new URL(decodeURIComponent(url));

    this.log(`[http] a client connected proxying ${href}`);

    const requestData = {
      host,
      pathname,
      href,
      method,
      headers,
      body
    };

    const snapshotData = this.fetchFromSnapshot(requestData);
    if (snapshotData) {
      return snapshotData;
    }

    const serverData = this.fetchFromServer(requestData);
    if (serverData) {
      return serverData;
    }

    return null;
  }

  fetchFromSocketIOServer(requestData) {
    return new Promise(resolve => {
      const { href, data } = requestData;

      const proxySocket = ioClient(href, {
        transports: ["websocket"]
      });

      proxySocket.emit("message", data, response => {
        this.log("[socket.io] got response from proxied server");

        const snapshotData = {
          data: Buffer.from(JSON.stringify(response), "binary"),
          info: requestData,
          requestData
        };

        this.saveSnapshot(snapshotData);
        resolve(snapshotData);
      });
    });
  }

  async recordReplaySocketIO(requestData) {
    const snapshotData = this.fetchFromSnapshot(requestData);
    if (snapshotData) {
      return snapshotData;
    }

    const serverData = await this.fetchFromSocketIOServer(requestData);
    if (serverData) {
      return serverData;
    }

    return null;
  }

  async serveHttpData(req, res) {
    const { referer, host } = req.headers;

    if (req.url.indexOf("http") === -1) {
      if (host.indexOf(`.localhost:${port}`) !== -1) {
        req.url = `https://${host.replace(`.localhost:${port}`, "")}/${
          req.url
        }`;
      }
    }

    if (req.url.indexOf("http") === -1) {
      if (referer) {
        const { origin } = new URL(
          referer.substring(referer.indexOf("/http") + 1)
        );
        req.url = `${origin}/${req.url}`;
      }
    }

    try {
      const { data, info } = await this.recordReplayData(req);
      res.set("Content-Type", info.headers["content-type"]);

      this.log("[http] serving data to client");
      res.send(Buffer.from(data, "binary"));
    } catch (error) {
      this.log(error);
      res.send(null);
    }
  }
}

module.exports = MockServer;
