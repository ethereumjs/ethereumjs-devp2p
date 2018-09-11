const { EventEmitter } = require("events");
const dgram = require("dgram");
const ms = require("ms");
const createDebugLogger = require("debug");
const LRUCache = require("lru-cache");
const message = require("./message");
const { keccak256, pk2id, createDeferred, v4, v5 } = require("../util");
const chalk = require("chalk");
const debug = createDebugLogger("devp2p:dpt:server");

const createSocketUDP4 = dgram.createSocket.bind(null, "udp4");

class Server extends EventEmitter {
  constructor(dpt, privateKey, options) {
    super();
    this._dpt = dpt;
    this._privateKey = privateKey;

    if (options.version === "5") {
      this._version = v5;
    } else {
      this._version = v4;
    }

    console.log(
      chalk.green(
        `Starting node discovery protocol with version: ${this._version}`
      )
    );

    this._timeout = options.timeout || ms("10s");

    this._endpoint = options.endpoint || {
      address: "0.0.0.0",
      udpPort: null,
      tcpPort: null
    };
    this._requests = new Map();
    this._parityRequestMap = new Map();
    this._requestsCache = new LRUCache({
      max: 1000,
      maxAge: ms("1s"),
      stale: false
    });

    const createSocket = options.createSocket || createSocketUDP4;
    this._socket = createSocket();
    this._socket.once("listening", () => this.emit("listening"));
    this._socket.once("close", () => this.emit("close"));
    this._socket.on("error", err => this.emit("error", err));

    // processes incoming messages
    this._socket.on("message", (msg, rinfo) => {
      try {
        console.log(chalk.green(`+++++ +++++ message received --> server.js`));
        // console.log(
        //   chalk.green(`msg =  ${JSON.stringify(message.decode(msg))}`)
        // );
        console.log(chalk.green(`rinfo =  ${JSON.stringify(rinfo)}`));

        this._handler(msg, rinfo);
      } catch (err) {
        this.emit("error", err);
      }
    });
  }

  bind(...args) {
    this._isAliveCheck();
    debug("call .bind");

    this._socket.bind(...args);
  }

  destroy(...args) {
    this._isAliveCheck();
    debug("call .destroy");

    this._socket.close(...args);
    this._socket = null;
  }

  async hey(peer) {
    this._isAliveCheck();

    const rckey = `${peer.address}:${peer.udpPort}`;
    const promise = this._requestsCache.get(rckey);
    if (promise !== undefined) return promise;

    const hash = this._send(peer, "hey", {
      version: this._version,
      from: this._endpoint,
      to: peer
    });

    const deferred = createDeferred();
    const rkey = hash.toString("hex");

    this._requests.set(rkey, {
      peer,
      deferred,
      timeoutId: setTimeout(() => {
        if (this._requests.get(rkey) !== undefined) {
          debug(
            `ping timeout: ${peer.address}:${peer.udpPort} ${peer.id &&
              peer.id.toString("hex")}`
          );
          this._requests.delete(rkey);
          deferred.reject(
            new Error(`Timeout error: ping ${peer.address}:${peer.udpPort}`)
          );
        } else {
          return deferred.promise;
        }
      }, this._timeout)
    });

    this._requestsCache.set(rckey, deferred.promise);
    return deferred.promise;
  }

  // hey(peer, id) {
  //   this._isAliveCheck();
  //   this._send(peer, "hey", { id });
  // }

  // requestTicket(peer, id) {
  //   this._isAliveCheck();
  //   this._send(peer, "requestTicket", { id });
  // }

  neighbors(peer, id) {
    this._isAliveCheck();
    this._send(peer, "neighbors", { id });
  }

  _isAliveCheck() {
    if (this._socket === null) throw new Error("Server already destroyed");
  }

  _send(peer, typename, data) {
    // debug(
    //   `send ${typename} to ${peer.address}:${peer.udpPort} (peerId: ${peer.id &&
    //     peer.id.toString("hex")})`
    // );

    const msg = message.encode(typename, data, this._privateKey);
    // Parity hack
    // There is a bug in Parity up to at lease 1.8.10 not echoing the hash from
    // discovery spec (hash: sha3(signature || packet-type || packet-data))
    // but just hashing the RLP-encoded packet data (see discovery.rs, on_ping())
    // 2018-02-28
    if (typename === "hey") {
      const rkeyParity = keccak256(msg.slice(98)).toString("hex");
      this._parityRequestMap.set(rkeyParity, msg.slice(0, 32).toString("hex"));
      setTimeout(() => {
        if (this._parityRequestMap.get(rkeyParity) !== undefined) {
          this._parityRequestMap.delete(rkeyParity);
        }
      }, this._timeout);
    }

    this._socket.send(msg, 0, msg.length, peer.udpPort, peer.address);
    return msg.slice(0, 32); // message id
  }

  // processes each incoming message by it's message type, msg in binary data
  _handler(msg, rinfo) {
    const info = message.decode(msg);

    console.log("******* info.typename == " + info.typename);
    console.log(chalk.green(`+++++ +++++`));

    const peerId = pk2id(info.publicKey);
    debug(
      `received ${info.typename} from ${rinfo.address}:${
        rinfo.port
      } (peerId: ${peerId.toString("hex")})`
    );

    // add peer if not in our table
    const peer = this._dpt.getPeer(peerId);
    if (
      peer === null &&
      info.typename === "hey" &&
      info.data.from.udpPort !== null
    ) {
      setTimeout(() => this.emit("peers", [info.data.from]), ms("100ms"));
    }

    switch (info.typename) {
      // case "ping":
      //   Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
      //   this._send(rinfo, "pong", {
      //     to: {
      //       address: rinfo.address,
      //       udpPort: rinfo.port,
      //       tcpPort: info.data.from.tcpPort
      //     },
      //     hash: msg.slice(0, 32)
      //   });
      //   break;

      // case "pong":
      //   var rkey = info.data.hash.toString("hex");
      //   const rkeyParity = this._parityRequestMap.get(rkey);
      //   if (rkeyParity) {
      //     rkey = rkeyParity;
      //     this._parityRequestMap.delete(rkeyParity);
      //   }
      //   const request = this._requests.get(rkey);
      //   if (request) {
      //     this._requests.delete(rkey);
      //     request.deferred.resolve({
      //       id: peerId,
      //       address: request.peer.address,
      //       udpPort: request.peer.udpPort,
      //       tcpPort: request.peer.tcpPort
      //     });
      //   }
      //   break;

      case "hey":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "hey", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;

      /*
          findNode packet (0x03)
          requests a neighbors packet containing the closest know nodes to the target hash.
      */
      case "findNode":
        //ping example, denotes response message type
        // Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        // this._send(rinfo, "neighbors", {
        //   to: {
        //     address: rinfo.address,
        //     udpPort: rinfo.port,
        //     tcpPort: info.data.from.tcpPort
        //   },
        //   hash: msg.slice(0, 32)
        // });
        // break;

        console.log(chalk.blue("-------- server.findNode()"));
        var rkey = info.data.hash.toString("hex");

        const rkeyParity = this._parityRequestMap.get(rkey);
        console.log(chalk.blue("-------- rkeyParity = " + rkeyParity));

        if (rkeyParity) {
          rkey = rkeyParity;
          this._parityRequestMap.delete(rkeyParity);
        }
        const request = this._requests.get(rkey);
        console.log(
          chalk.blue("-------- request = " + JSON.stringify(request))
        );

        if (request) {
          this._requests.delete(rkey);
          request.deferred.resolve({
            id: peerId,
            address: request.peer.address,
            udpPort: request.peer.udpPort,
            tcpPort: request.peer.tcpPort
          });
        }
        break;

      /*
          findNode packet (0x03)
          requests a neighbors packet containing the closest know nodes to the target hash.
        */
      // const findNode = {
      //   // console.log(chalk.yellow(`+++++ +++++`));
      //
      //   // console.log(chalk.yellow("******* findNode == " + info.typename));
      //   // console.log(chalk.yellow(`+++++ +++++`));
      //   encode: function(obj) {
      //     console.log(chalk.blue("******* findNode.encode == "));
      //     console.log(chalk.blue(`+++++ +++++`));
      //     return [endpoint.encode(obj.to), obj.hash, timestamp.encode(obj.timestamp)];
      //   },
      //   decode: function(payload) {
      //     return {
      //       to: endpoint.decode(payload[0]),
      //       hash: payload[1],
      //       timestamp: timestamp.decode(payload[2])
      //     };
      //   }
      // };

      case "neighbors":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "neighbors", {
          peers: this._dpt.getClosestPeers(info.data.id)
        });
        break;

      // case "neighbors":
      //   this.emit("peers", info.data.peers.map(peer => peer.endpoint));
      //   break;

      case "requestTicket":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "pong", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;

      case "ticket":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "pong", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;

      case "topicRegister":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "pong", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;

      case "topicQuery":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "pong", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;

      case "topicNodes":
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port });
        this._send(rinfo, "pong", {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        });
        break;
    }
  }
}

module.exports = Server;
