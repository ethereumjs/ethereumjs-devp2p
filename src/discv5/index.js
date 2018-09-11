const { EventEmitter } = require("events");
const secp256k1 = require("secp256k1");
const Buffer = require("safe-buffer").Buffer;
const { randomBytes } = require("crypto");
const createDebugLogger = require("debug");
const ms = require("ms");
const { pk2id, id2pk } = require("../util");
const KBucket = require("./kbucket");
const BanList = require("../dpt/ban-list");
const Server = require("./server");
const debug = createDebugLogger("devp2p:dpt");
const chalk = require("chalk");
const message = require("./message");

class DISCV5 extends EventEmitter {
  constructor(privateKey, options) {
    super();

    this._privateKey = Buffer.from(privateKey);
    this._id = pk2id(secp256k1.publicKeyCreate(this._privateKey, false));

    // debug binary data
    const info = id2pk(this._id);

    console.log(chalk.red(`+++++ index.js == DISCV5.this._id == ${info}`));

    this._banlist = new BanList();
    this._kbucket = new KBucket(this._id);
    this._kbucket.on("added", peer => this.emit("peer:added", peer));
    this._kbucket.on("removed", peer => this.emit("peer:removed", peer));
    this._kbucket.on("hey", (...args) => this._onKBucketPing(...args));

    this._server = new Server(this, this._privateKey, {
      createSocket: options.createSocket,
      timeout: options.timeout,
      version: options.version,
      endpoint: options.endpoint
    });

    this._server.once("listening", () => this.emit("listening"));
    this._server.once("close", () => this.emit("close"));
    this._server.on("peers", peers => this._onServerPeers(peers));
    this._server.on("error", err => this.emit("error", err));

    const refreshInterval = options.refreshInterval || ms("60s");
    this._refreshIntervalId = setInterval(
      () => this.refresh(),
      refreshInterval
    );
  }

  bind(...args) {
    this._server.bind(...args);
  }

  destroy(...args) {
    clearInterval(this._refreshIntervalId);
    this._server.destroy(...args);
  }

  _onKBucketPing(oldPeers, newPeer) {
    if (this._banlist.has(newPeer)) return;

    let count = 0;
    let err = null;
    for (let peer of oldPeers) {
      this._server
        .hey(peer)
        .catch(_err => {
          this._banlist.add(peer, ms("5m"));
          this._kbucket.remove(peer);
          err = err || _err;
        })
        .then(() => {
          if (++count < oldPeers.length) return;

          if (err === null) this._banlist.add(newPeer, ms("5m"));
          else this._kbucket.add(newPeer);
        });
    }
  }

  _onServerPeers(peers) {
    for (let peer of peers) this.addPeer(peer).catch(() => {});
  }

  async bootstrap(peer) {
    debug(`bootstrap with peer ${peer.address}:${peer.udpPort}`);

    peer = await this.addPeer(peer);
    this._server.neighbors(peer, this._id);
  }

  async addPeer(obj) {
    if (this._banlist.has(obj)) throw new Error("Peer is banned");
    debug(`attempt adding peer ${obj.address}:${obj.udpPort}`);

    // check k-bucket first
    const peer = this._kbucket.get(obj);
    if (peer !== null) return peer;

    // check that peer is alive
    try {
      const peer = await this._server.hey(obj);
      this.emit("peer:new", peer);
      this._kbucket.add(peer);
      return peer;
    } catch (err) {
      this._banlist.add(obj, ms("10m"));
      throw err;
    }
  }

  getPeer(obj) {
    return this._kbucket.get(obj);
  }

  getPeers() {
    return this._kbucket.getAll();
  }

  getClosestPeers(id) {
    return this._kbucket.closest(id);
  }

  removePeer(obj) {
    this._kbucket.remove(obj);
  }

  banPeer(obj, maxAge) {
    this._banlist.add(obj, maxAge);
    this._kbucket.remove(obj);
  }

  refresh() {
    const peers = this.getPeers();
    debug(`call .refresh (${peers.length} peers in table)`);

    for (let peer of peers) this._server.neighbors(peer, randomBytes(64));
  }
}

module.exports = DISCV5;
