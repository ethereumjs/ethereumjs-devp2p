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

const BOOTNODES = require('ethereum-common').bootstrapNodes.filter((node) => {
  return node.chainId === CHAIN_ID
}).map((node) => {
  return {
    address: node.ip,
    udpPort: node.port,
    tcpPort: node.port
  }
})
const REMOTE_CLIENTID_FILTER = ['go1.5', 'go1.6', 'go1.7', 'quorum', 'pirl', 'ubiq', 'gmc', 'gwhale', 'prichain']

const CHECK_BLOCK_TITLE = 'Istanbul Fork' // Only for debugging/console output
const CHECK_BLOCK_NR = 9069000
const CHECK_BLOCK = '451226b98bf4f784314e9ca2daaa30dc664a387c342ef775ba2d88682a27c084'
const CHECK_BLOCK_HEADER = rlp.decode(Buffer.from('f90216a01db3fa70c7ceb9ee9f3fff29387c72d47080843a099b7ea9013697f57439538ba01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347945a0b54d5dc17e0aadc383d2db43b0a0d3e029c4ca0f3917914f693a985a23ee2b623f6d1c1bcffb8e597e63cf1fb0cbabb9947a9c7a0cee16501e007fe5240aa50faa96cce60c7de8ae56f34044d850e378b98e04537a045e89ab99ba6573f5d5b5f971a19baa367b557c504c34bb2a9fef37a5c88ec71b901003814400a926034200085a082008658901b00c0027141b0002a084858020011a0284a06000187c02204829c2034120100960a002a3c1046032002048100308c01000040c50a0142094411014a0000c024220000a0204602c00510a30488444a6a020805083a044101802800850300802084606200100e2c2804198450210020500485508a00548c8010290006804400560281f4218000223d31428000c21828640a8c00000f044008201840818280a084220004017012081002c10000a03253505398c646c901161100100210020144ae0805a06084890508201a000251d884822050a401004012001ca0c692160682281016621136d084401410d03624b200648709163c3ed1a37d838a61c8838893698385b637845dec42e5955050594520737061726b706f6f6c2d6574682d7477a08f73e02f7488e2e7a1c09bdff063c5d438f3181fa0ba6ff9c25e944f53c29db38843ba6670025bc5e0', 'hex'))

const getPeerAddr = (peer) => `${peer._socket.remoteAddress}:${peer._socket.remotePort}`

// DPT
const dpt = new devp2p.DPT(PRIVATE_KEY, {
  refreshInterval: 30000,
  endpoint: {
    address: '0.0.0.0',
    udpPort: null,
    tcpPort: null
  }
})

dpt.on('error', (err) => console.error(chalk.red(`DPT error: ${err}`)))

// RLPx
const rlpx = new devp2p.RLPx(PRIVATE_KEY, {
  dpt: dpt,
  maxPeers: 25,
  capabilities: [
    devp2p.ETH.eth63,
    devp2p.ETH.eth62
  ],
  remoteClientIdFilter: REMOTE_CLIENTID_FILTER,
  listenPort: null
})

rlpx.on('error', (err) => console.error(chalk.red(`RLPx error: ${err.stack || err}`)))

rlpx.on('peer:added', (peer) => {
  const addr = getPeerAddr(peer)
  const eth = peer.getProtocols()[0]
  const requests = { headers: [], bodies: [], msgTypes: {} }

  const clientId = peer.getHelloMessage().clientId
  console.log(chalk.green(`Add peer: ${addr} ${clientId} (eth${eth.getVersion()}) (total: ${rlpx.getPeers().length})`))

  eth.sendStatus({
    networkId: CHAIN_ID,
    td: devp2p._util.int2buffer(17179869184), // total difficulty in genesis block
    bestHash: Buffer.from('d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3', 'hex'),
    genesisHash: Buffer.from('d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3', 'hex')
  })

  // check CHECK_BLOCK
  let forkDrop = null
  let forkVerified = false
  eth.once('status', () => {
    eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [ CHECK_BLOCK_NR, 1, 0, 0 ])
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
            eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [ blockHash, 1, 0, 0 ])
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
            console.log(`${addr} expected one header for ${CHECK_BLOCK_TITLE} verify (received: ${payload.length})`)
            peer.disconnect(devp2p.RLPx.DISCONNECT_REASONS.USELESS_PEER)
            break
          }

          const expectedHash = CHECK_BLOCK
          const header = new EthereumBlock.Header(payload[0])
          if (header.hash().toString('hex') === expectedHash) {
            console.log(`${addr} verified to be on the same side of the ${CHECK_BLOCK_TITLE}`)
            clearTimeout(forkDrop)
            forkVerified = true
          }
        } else {
          if (payload.length > 1) {
            console.log(`${addr} not more than one block header expected (received: ${payload.length})`)
            break
          }

          let isValidPayload = false
          const header = new EthereumBlock.Header(payload[0])
          while (requests.headers.length > 0) {
            const blockHash = requests.headers.shift()
            if (header.hash().equals(blockHash)) {
              isValidPayload = true
              setTimeout(() => {
                eth.sendMessage(devp2p.ETH.MESSAGE_CODES.GET_BLOCK_BODIES, [ blockHash ])
                requests.bodies.push(header)
              }, ms('0.1s'))
              break
            }
          }

          if (!isValidPayload) {
            console.log(`${addr} received wrong block header ${header.hash().toString('hex')}`)
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
          console.log(`${addr} not more than one block body expected (received: ${payload.length})`)
          break
        }

        let isValidPayload = false
        while (requests.bodies.length > 0) {
          const header = requests.bodies.shift()
          const block = new EthereumBlock([header.raw, payload[0][0], payload[0][1]])
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
  console.log(chalk.yellow(`Remove peer: ${getPeerAddr(peer)} - ${who}, reason: ${peer.getDisconnectPrefix(reasonCode)} (${String(reasonCode)}) (total: ${total})`))
})

rlpx.on('peer:error', (peer, err) => {
  if (err.code === 'ECONNRESET') return

  if (err instanceof assert.AssertionError) {
    const peerId = peer.getId()
    if (peerId !== null) dpt.banPeer(peerId, ms('5m'))

    console.error(chalk.red(`Peer error (${getPeerAddr(peer)}): ${err.message}`))
    return
  }

  console.error(chalk.red(`Peer error (${getPeerAddr(peer)}): ${err.stack || err}`))
})

// uncomment, if you want accept incoming connections
// rlpx.listen(30303, '0.0.0.0')
// dpt.bind(30303, '0.0.0.0')

for (let bootnode of BOOTNODES) {
  dpt.bootstrap(bootnode).catch((err) => {
    console.error(chalk.bold.red(`DPT bootstrap error: ${err.stack || err}`))
  })
}

// connect to local ethereum node (debug)
/*
dpt.addPeer({ address: '127.0.0.1', udpPort: 30303, tcpPort: 30303 })
  .then((peer) => {
    return rlpx.connect({
      id: peer.id,
      address: peer.address,
      port: peer.tcpPort
    })
  })
  .catch((err) => console.log(`error on connection to local node: ${err.stack || err}`))
*/

const txCache = new LRUCache({ max: 1000 })
function onNewTx (tx, peer) {
  const txHashHex = tx.hash().toString('hex')
  if (txCache.has(txHashHex)) return

  txCache.set(txHashHex, true)
  console.log(`New tx: ${txHashHex} (from ${getPeerAddr(peer)})`)
}

const blocksCache = new LRUCache({ max: 100 })
function onNewBlock (block, peer) {
  const blockHashHex = block.hash().toString('hex')
  const blockNumber = devp2p._util.buffer2int(block.header.number)
  if (blocksCache.has(blockHashHex)) return

  blocksCache.set(blockHashHex, true)
  console.log(`----------------------------------------------------------------------------------------------------------`)
  console.log(`New block ${blockNumber}: ${blockHashHex} (from ${getPeerAddr(peer)})`)
  console.log(`----------------------------------------------------------------------------------------------------------`)
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
  const queueLength2 = rlpx._peersQueue.filter((o) => o.ts <= Date.now()).length

  console.log(chalk.yellow(`Total nodes in DPT: ${peersCount}, open slots: ${openSlots}, queue: ${queueLength} / ${queueLength2}`))
}, ms('30s'))
