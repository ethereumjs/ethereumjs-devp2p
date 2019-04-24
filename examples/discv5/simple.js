const chalk = require('chalk')
const { DISCV5 } = require('../../src')
const Buffer = require('safe-buffer').Buffer

const PRIVATE_KEY =
  'd772e3d6a001a38064dd23964dd2836239fa0e6cec8b28972a87460a17210fe9'
const BOOTNODES = require('./../bootstrapNodes.json').map(node => {
  return {
    address: node.ip,
    udpPort: node.port,
    tcpPort: node.port
  }
})

const discv5 = new DISCV5(Buffer.from(PRIVATE_KEY, 'hex'), {
  version: '5',
  endpoint: {
    address: '0.0.0.0',
    udpPort: null,
    tcpPort: null
  }
})

discv5.on('error', err => console.error(chalk.red(err.stack || err)))

discv5.on('peer:added', peer => {
  const info = `(${peer.id.toString('hex')},${peer.address},${peer.udpPort},${
    peer.tcpPort
  })`
  console.log(
    chalk.green(`New peer: ${info} (total: ${discv5.getPeers().length})`)
  )
})

discv5.on('peer:removed', peer => {
  console.log(
    chalk.yellow(
      `Remove peer: ${peer.id.toString('hex')} (total: ${
        discv5.getPeers().length
      })`
    )
  )
})

// for accept incoming connections uncomment next line
discv5.bind(30303, '0.0.0.0')

for (let bootnode of BOOTNODES) {
  discv5
    .bootstrap(bootnode)
    .catch(err => console.error(chalk.bold.red(err.stack || err)))
}
