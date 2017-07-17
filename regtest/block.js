'use strict';

var chai = require('chai');
var expect = chai.expect;
var async = require('async');
var BitcoinRPC = require('bitcoind-rpc');
var path = require('path');
var Utils = require('./utils');
var constants = require('../lib/constants');
var zmq = require('zmq');

var debug = true;
var extraDebug = true;
var bitcoreDataDir = '/tmp/testtmpfs/bitcore';
var bitcoinDataDir = '/tmp/testtmpfs/bitcoin';

var rpcConfig = {
  protocol: 'http',
  user: 'bitcoin',
  pass: 'local321',
  host: '127.0.0.1',
  port: '58332',
  rejectUnauthorized: false
};

var bitcoin = {
  args: {
    datadir: bitcoinDataDir,
    listen: 1,
    regtest: 1,
    server: 1,
    rpcuser: rpcConfig.user,
    rpcpassword: rpcConfig.pass,
    rpcport: rpcConfig.port
  },
  datadir: bitcoinDataDir,
  exec: 'bitcoind', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/bitcoind
  process: null
};

var bitcore = {
  configFile: {
    file: bitcoreDataDir + '/bitcore-node.json',
    conf: {
      network: 'regtest',
      port: 53001,
      datadir: bitcoreDataDir,
      services: [
        'p2p',
        'db',
        'web',
        'block',
        'timestamp',
        'block-test'
      ],
      servicesConfig: {
        p2p: {
          peers: [
            {
              ip: { v4: '127.0.0.1' }
            }
          ]
        },
        'block-test': {
          requirePath: path.resolve(__dirname + '/test_bus.js')
        }
      }
    }
  },
  httpOpts: {
    protocol: 'http:',
    hostname: 'localhost',
    port: 53001,
  },
  opts: { cwd: bitcoreDataDir },
  datadir: bitcoreDataDir,
  exec: path.resolve(__dirname, '../bin/bitcore-node'),
  args: ['start'],
  process: null
};

var opts = {
  debug: debug,
  bitcore: bitcore,
  bitcoin: bitcoin,
  bitcoinDataDir: bitcoinDataDir,
  bitcoreDataDir: bitcoreDataDir,
  rpc: new BitcoinRPC(rpcConfig),
  blockHeight: 0,
  initialHeight: 150,
  path: '/test/info',
  errorFilter: function(req, res) {
    try {
      var info = JSON.parse(res);
      if (info.result) {
        return;
      }
    } catch(e) {
      return e;
    }
  }
};

var utils = new Utils(opts);

var subSocket;
var blocks = [];

function processMessages(topic, message) {
  var topicStr = topic.toString();
  if (topicStr === 'block/block') {
    return blocks.push(message);
  }
}

function setupZmqSubscriber(callback) {

  subSocket = zmq.socket('sub');
  subSocket.on('connect', function(fd, endPoint) {
    if (debug) {
      console.log('ZMQ connected to:', endPoint);
    }
  });

  subSocket.on('disconnect', function(fd, endPoint) {
    if (debug) {
      console.log('ZMQ disconnect:', endPoint);
    }
  });

  subSocket.monitor(100, 0);
  subSocket.connect('tcp://127.0.0.1:38332');
  subSocket.subscribe('block');
  subSocket.on('message', processMessages);
  callback();
}

describe('Block Operations', function() {

  this.timeout(60000);

  describe('Sync Block Headers', function() {

    var self = this;

    after(function(done) {
      utils.cleanup(done);
    });

    before(function(done) {
      async.series([
        utils.startBitcoind.bind(utils),
        utils.waitForBitcoinReady.bind(utils),
        utils.startBitcoreNode.bind(utils),
        utils.waitForBitcoreNode.bind(utils),
        setupZmqSubscriber
      ], done);
    });

    it.only('should be able to get historical blocks from the network', function(done) {
      var filter = { startHash: constants.BITCOIN_GENESIS_HASH.regtest };
      utils.queryBitcoreNode(Object.assign({
        path: '/test/p2p/blocks?filter=' + JSON.stringify(filter),
      }, bitcore.httpOpts), function(err) {

        if(err) {
          return done(err);
        }

        setTimeout(function() {
          expect(blocks.length).to.equal(150);
          done();
        }, 2000);


      });
    });

    it('should sync block hashes as keys and heights as values', function(done) {

      //async.timesLimit(opts.initialHeight, 12, function(n, next) {
      //  utils.queryBitcoreNode(Object.assign({
      //    path: '/test/block/hash/' + n
      //  }, bitcore.httpOpts), function(err, res) {

      //    if(err) {
      //      return done(err);
      //    }
      //    res = JSON.parse(res);
      //    expect(res.height).to.equal(n);
      //    expect(res.hash.length).to.equal(64);
      //    next(null, res.hash);
      //  });
      //}, function(err, hashes) {

      //  if(err) {
      //    return done(err);
      //  }
      //  self.hashes = hashes;
      //  done();

      //});
    });

    it('should sync block heights as keys and hashes as values', function(done) {
      async.timesLimit(opts.initialHeight, 12, function(n, next) {
        utils.queryBitcoreNode(Object.assign({
          path: '/test/block/height/' + self.hashes[n]
        }, bitcore.httpOpts), function(err, res) {

          if(err) {
            return done(err);
          }
          res = JSON.parse(res);
          expect(res.height).to.equal(n);
          expect(res.hash).to.equal(self.hashes[n]);
          next();
        });
      }, function(err) {

        if(err) {
          return done(err);
        }
        done();

      });

    });
  });

});