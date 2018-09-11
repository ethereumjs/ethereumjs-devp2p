/*  ------------------------------------------------------------------------------
		File: node_record.js
		Description: Ethereum Node Record (ENR) data structure
		------------------------------------------------------------------------------
		Specification: https://github.com/fjl/p2p-drafts/blob/master/discv5-enr.md
*/
const secp256k1 = require("secp256k1");
const ip = require("ip");
const rlp = require("rlp-encoding");
const Buffer = require("safe-buffer").Buffer;
const { keccak256, int2buffer, buffer2int, assertEq } = require("../util");

/*  ---------------------------------------
		*** Constants ***
		---------------------------------------
		MAX_RECORD_SIZE = 300 BYTES
		SEQUENCE_SIZE = 64BITS = 8 bytes
*/
const MAX_RECORD_SIZE = 300;
const SEQUENCE_SIZE = 8;

/*  ---------------------------------------
		*** Node Record Specification ***
		---------------------------------------
		Record {
			signature: IdentityScheme,
			sequence: 64bit int,
			key/value: mapping
	}
*/

class EthereumNodeRecord {

	// sorted key/value list
	constructor(publicKey) {
	}

	// let identityScheme = new DefaultIdentityScheme();

	// signature of record contents
	//let signature = "a";

	// sequence number that acts like a nonce for record updates
	let sequence = BigInt(0);

	// this is how records are signed and encoded
	let content = Buffer.concat([
		rlp.encode(signature),
		rpl.encode(sequence),
		rlp.encode("id"), rlp.encode(defaultKeyValuePairs.get("id")),
		rlp.encode("secp256k1"), rlp.encode(defaultKeyValuePairs.get("secp256k1")),
		rlp.encode("ip"), rlp.encode(defaultKeyValuePairs.get("ip")),
		rlp.encode("tcp"), rlp.encode(defaultKeyValuePairs.get("tcp")),
		rlp.encode("udp"), rlp.encode(defaultKeyValuePairs.get("udp"))]);

	printRecord() {
			console.log(this.signature);
	}

}

/*  ---------------------------------------
		*** RLP Encoding ***
		---------------------------------------
*/
	function encode(typename, data, privateKey) {
	  const type = types.byName[typename];
	  if (type === undefined) throw new Error(`Invalid typename: ${typename}`);
	  const encodedMsg = messages[typename].encode(data);
	  const typedata = Buffer.concat([Buffer.from([type]), rlp.encode(encodedMsg)]);
	  const sighash = keccak256(typedata);
		const sig = secp256k1.sign(sighash, privateKey);
		const hashdata = Buffer.concat([
	    sig.signature,
	    Buffer.from([sig.recovery]),
	    typedata
	  ]);
	  const hash = keccak256(hashdata);
	  return Buffer.concat([hash, hashdata]);
	}

/*  ---------------------------------------
		*** Pre-defined Key/Value Pairs ***
		---------------------------------------
		Key {
			id = vlaue,
			secp256k1 = vlaue,
			ip = vlaue,
			tcp = vlaue,
			udp = vlaue
	}
*/

let defaultKeyValuePairs = new Map(
	[["id", "v4"],				// name of identity scheme
	["secp256k1", ""],		// compressed pub key 33 bytes
	["ip", ""],						// ip address 4 or 6 bytes
	["tcp", ""], 					// tcp port number
	["udp", ""]]);				// udp port number

/*  ---------------------------------------
		*** "v4" Inentity Scheme ***
		---------------------------------------
		IdentityScheme{
			sign() -> createRecordSignature(record contents),
			verify() -> validateRecordSignature(),
			derive() -> deriveNodeAddress()
		}
*/
class DefaultIdentityScheme {
	let defaultSchemeList = "v4";

	// signs a records content
	function sign(content) {
		const sighash = keccak256(content);
	}

	// verifies a node record
	function verify(signature, publicKey) {
		let isValid = new Boolean(signature == defaultKeyValuePairs.get("secp256k1"));
		return isValid;
	}

	// derives the node address
	function derive(publicKey) {
		const nodeAddress = keccak256(publicKey);
		return nodeAddress;
	}
}

module.exports = { EthereumNodeRecord, DefaultIdentityScheme };
