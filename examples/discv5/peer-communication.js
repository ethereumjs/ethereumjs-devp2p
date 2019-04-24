// run it:
// npm install
// node -r babel-register ./examples/peer-communication.js

const devp2p = require('../src')
const EthereumTx = require('ethereumjs-tx')
const EthereumBlock = require('ethereumjs-block')
const LRUCache = require('lru-cache')
const ms = require('ms')
const chalk = require('chalk')
const assert = require('assert')
const { randomBytes } = require('crypto')
const rlp = require('rlp-encoding')
const Buffer = require('safe-buffer').Buffer

const PRIVATE_KEY = randomBytes(32)
const CHAIN_ID = 1

const BOOTNODES = require('./bootstrapNodes.json')
  .filter(node => {
    return node.chainId === CHAIN_ID
  })
  .map(node => {
    return {
      address: node.ip,
      udpPort: node.port,
      tcpPort: node.port
    }
  })

const CHECK_BLOCK_TITLE = 'Byzantium Fork' // Only for debugging/console output
const CHECK_BLOCK_NR = 4370000
const CHECK_BLOCK =
  'b1fcff633029ee18ab6482b58ff8b6e95dd7c82a954c852157152a7a6d32785e'
const CHECK_BLOCK_HEADER = rlp.decode(
  Buffer.from(
    'f9020aa0a0890da724dd95c90a72614c3a906e402134d3859865f715f5dfb398ac00f955a01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347942a65aca4d5fc5b5c859090a6c34d164135398226a074cccff74c5490fbffc0e6883ea15c0e1139e2652e671f31f25f2a36970d2f87a00e750bf284c2b3ed1785b178b6f49ff3690a3a91779d400de3b9a3333f699a80a0c68e3e82035e027ade5d966c36a1d49abaeec04b83d64976621c355e58724b8bb90100040019000040000000010000000000021000004020100688001a05000020816800000010a0000100201400000000080100020000000400080000800004c0200000201040000000018110400c000000200001000000280000000100000010010080000120010000050041004000018000204002200804000081000011800022002020020140000000020005080001800000000008102008140008600000000100000500000010080082002000102080000002040120008820400020100004a40801000002a0040c000010000114000000800000050008300020100000000008010000000100120000000040000000808448200000080a00000624013000000080870552416761fabf83475b02836652b383661a72845a25c530894477617266506f6f6ca0dc425fdb323c469c91efac1d2672dfdd3ebfde8fa25d68c1b3261582503c433788c35ca7100349f430',
    'hex'
  )
)

const getPeerAddr = peer =>
  `${peer._socket.remoteAddress}:${peer._socket.remotePort}`

// set the default version to 4
let VERSION = devp2p._util.v4

// option to run version 5 via cli: node -r babel-register ./examples/peer-communication.js 5
const cliVersion = process.argv[2]

if (cliVersion == 5) {
  VERSION = devp2p._util.v5
}

// DPT
const dpt = new devp2p.DPT(PRIVATE_KEY, {
  refreshInterval: 30000,
  version: VERSION,
  endpoint: {
    address: '0.0.0.0',
    udpPort: null,
    tcpPort: null
  }
})

dpt.on('error', err => console.error(chalk.red(`DPT error: ${err}`)))

// RLPx
const rlpx = new devp2p.RLPx(PRIVATE_KEY, {
  dpt: dpt,
  maxPeers: 25,
  capabilities: [devp2p.ETH.eth63, devp2p.ETH.eth62],
  listenPort: null
})

rlpx.on('error', err =>
  console.error(chalk.red(`RLPx error: ${err.stack || err}`))
)

rlpx.on('peer:added', peer => {
  const addr = getPeerAddr(peer)
  const eth = peer.getProtocols()[0]
  const requests = { headers: [], bodies: [], msgTypes: {} }

  const clientId = peer.getHelloMessage().clientId

  console.log(
    chalk.green(
      `Add peer: ${addr} ${clientId} (eth${eth.getVersion()}) (total: ${
        rlpx.getPeers().length
      })`
    )
  )

  eth.sendStatus({
    networkId: CHAIN_ID,
    td: devp2p._util.int2buffer(17179869184), // total difficulty in genesis block
    bestHash: Buffer.from(
      'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
      'hex'
    ),
    genesisHash: Buffer.from(
      'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
      'hex'
    )
  })

  // check CHECK_BLOCK
  let forkDrop = null
  let forkVerified = false
  eth.once('status', () => {
    eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [
      CHECK_BLOCK_NR,
      1,
      0,
      0
    ])
    forkDrop = setTimeout(() => {
      peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
    }, ms('15s'))
    peer.once('close', () => clearTimeout(forkDrop))
  })

  eth.on('message', async (code, payload) => {
    if (code in requests.msgTypes) {
      requests.msgTypes[code] += 1
    } else {
      requests.msgTypes[code] = 1
    }

    switch (code) {
      case devp2p.ETH.MESSAGE_CODES.NEW_BLOCK_HASHES:
        if (!forkVerified) break

        for (let item of payload) {
          const blockHash = item[0]
          if (blocksCache.has(blockHash.toString('hex'))) continue
          setTimeout(() => {
            eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [
              blockHash,
              1,
              0,
              0
            ])
            requests.headers.push(blockHash)
          }, ms('0.1s'))
        }
        break

      case devp2p.ETH.MESSAGE_CODES.TX:
        if (!forkVerified) break

        for (let item of payload) {
          const tx = new EthereumTx(item)
          if (isValidTx(tx)) onNewTx(tx, peer)
        }

        break

      case devp2p.ETH.MESSAGE_CODES.GET_BLOCK_HEADERS:
        const headers = []
        // hack
        if (devp2p._util.buffer2int(payload[0]) === CHECK_BLOCK_NR) {
          headers.push(CHECK_BLOCK_HEADER)
        }

        if (requests.headers.length === 0 && requests.msgTypes[code] >= 8) {
          peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
        } else {
          eth.sendMessage(devp2p.ETH.MESSAGE_CODES.BLOCK_HEADERS, headers)
        }
        break

      case devp2p.ETH.MESSAGE_CODES.BLOCK_HEADERS:
        if (!forkVerified) {
          if (payload.length !== 1) {
            peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
            break
          }

          const expectedHash = CHECK_BLOCK
          const header = new EthereumBlock.Header(payload[0])
          if (header.hash().toString('hex') === expectedHash) {
            clearTimeout(forkDrop)
            forkVerified = true
          }
        } else {
          let isValidPayload = false
          const header = new EthereumBlock.Header(payload[0])
          while (requests.headers.length > 0) {
            const blockHash = requests.headers.shift()
            if (header.hash().equals(blockHash)) {
              isValidPayload = true
              setTimeout(() => {
                eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_BODIES, [
                  blockHash
                ])
                requests.bodies.push(header)
              }, ms('0.1s'))
              break
            }
          }

          if (!isValidPayload) {
            console.log(
              `${addr} received wrong block header ${header
                .hash()
                .toString('hex')}`
            )
          }
        }

        break

      case devp2p.ETH.MESSAGE_CODES.GET_BLOCK_BODIES:
        if (requests.headers.length === 0 && requests.msgTypes[code] >= 8) {
          peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
        } else {
          eth.sendMessage(devp2p.ETH.MESSAGE_CODES.BLOCK_BODIES, [])
        }
        break

      case devp2p.ETH.MESSAGE_CODES.BLOCK_BODIES:
        if (!forkVerified) break

        if (payload.length !== 1) {
          console.log(
            `${addr} not more than one block body expected (received: ${
              payload.length
            })`
          )
          break
        }

        let isValidPayload = false
        while (requests.bodies.length > 0) {
          const header = requests.bodies.shift()
          const block = new EthereumBlock([
            header.raw,
            payload[0][0],
            payload[0][1]
          ])
          const isValid = await isValidBlock(block)
          if (isValid) {
            isValidPayload = true
            onNewBlock(block, peer)
            break
          }
        }

        if (!isValidPayload) {
          console.log(`${addr} received wrong block body`)
        }

        break

      case devp2p.ETH.MESSAGE_CODES.NEW_BLOCK:
        if (!forkVerified) break

        const newBlock = new EthereumBlock(payload[0])
        const isValidNewBlock = await isValidBlock(newBlock)
        if (isValidNewBlock) onNewBlock(newBlock, peer)

        break

      case devp2p.ETH.MESSAGE_CODES.GET_NODE_DATA:
        if (requests.headers.length === 0 && requests.msgTypes[code] >= 8) {
          peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
        } else {
          eth.sendMessage(devp2p.ETH.MESSAGE_CODES.NODE_DATA, [])
        }
        break

      case devp2p.ETH.MESSAGE_CODES.NODE_DATA:
        break

      case devp2p.ETH.MESSAGE_CODES.GET_RECEIPTS:
        if (requests.headers.length === 0 && requests.msgTypes[code] >= 8) {
          peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
        } else {
          eth.sendMessage(devp2p.ETH.MESSAGE_CODES.RECEIPTS, [])
        }
        break

      case devp2p.ETH.MESSAGE_CODES.RECEIPTS:
        break
    }
  })
})

rlpx.on('peer:removed', (peer, reasonCode, disconnectWe) => {
  const who = disconnectWe ? 'we disconnect' : 'peer disconnect'
  const total = rlpx.getPeers().length
  console.log(
    chalk.yellow(
      `Remove peer: ${getPeerAddr(
        peer
      )} - ${who}, reason: ${peer.getDisconnectPrefix(reasonCode)} (${String(
        reasonCode
      )}) (total: ${total})`
    )
  )
})

rlpx.on('peer:error', (peer, err) => {
  if (err.code === 'ECONNRESET') return
  if (err instanceof assert.AssertionError) {
    const peerId = peer.getId()
    if (peerId !== null) dpt.banPeer(peerId, ms('5m'))
    console.error(
      chalk.red(`Peer error (${getPeerAddr(peer)}): ${err.message}`)
    )
    return
  }
  console.error(
    chalk.red(`Peer error (${getPeerAddr(peer)}): ${err.stack || err}`)
  )
})

// // uncomment, if you want accept incoming connections
// rlpx.listen(30303, '0.0.0.0')
// dpt.bind(30303, '0.0.0.0')

for (let bootnode of BOOTNODES) {
  dpt.bootstrap(bootnode).catch(err => {
    console.error(chalk.bold.red(`DPT bootstrap error: ${err.stack || err}`))
  })
}

const txCache = new LRUCache({ max: 1000 })
function onNewTx (tx, peer) {
  const txHashHex = tx.hash().toString('hex')
  if (txCache.has(txHashHex)) return
  txCache.set(txHashHex, true)
}

const blocksCache = new LRUCache({ max: 100 })
function onNewBlock (block, peer) {
  const blockHashHex = block.hash().toString('hex')
  const blockNumber = devp2p._util.buffer2int(block.header.number)
  if (blocksCache.has(blockHashHex)) return
  blocksCache.set(blockHashHex, true)
  for (let tx of block.transactions) onNewTx(tx, peer)
}

function isValidTx (tx) {
  return tx.validate(false)
}

async function isValidBlock (block) {
  if (!block.validateUnclesHash()) return false
  if (!block.transactions.every(isValidTx)) return false
  return new Promise((resolve, reject) => {
    block.genTxTrie(() => {
      try {
        resolve(block.validateTransactionsTrie())
      } catch (err) {
        reject(err)
      }
    })
  })
}

setInterval(() => {
  const peersCount = dpt.getPeers().length
  const openSlots = rlpx._getOpenSlots()
  const queueLength = rlpx._peersQueue.length
  const queueLength2 = rlpx._peersQueue.filter(o => o.ts <= Date.now()).length

  console.log(
    chalk.yellow(
      `Total nodes in DPT: ${peersCount}, open slots: ${openSlots}, queue: ${queueLength} / ${queueLength2}`
    )
  )
}, ms('30s'))
