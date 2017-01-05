"use strict";

// TODO - daemonize/set interval
// TODO - check existing record and if no change needed, don't update
// throw new Error(require('util').inspect(data.DBInstances[i].Endpoint, {showHidden: false, depth: null}));

var pidfile = '/tmp/rcrr.pid';

// write the PID file to avoid collision
writePID();

process
  .on('exit',               exitHandler.bind(null, {cleanup:  true}))   // do something when app is closing
  .on('SIGINT',             exitHandler.bind(null, {exit:     true}))   // catches ctrl+c event
  .on('uncaughtException',  exitHandler.bind(null, {exit:     true}));  //catches uncaught exceptions

processConfs(function(confs) {
  var batch = {};
  var cconfs  = confs.slice(0); // clone confs

  (function addClusterInfo() {
    var conf = cconfs.splice(0, 1)[0];

    console.log('\nProcessing Cluster Info for : ' + conf.rdscluster);

    getDBClustersSummary(conf, function(dbInfo) {
      try {
        var nosyncwait = conf.nosyncwait || false,
            cred = {r53zoneid: conf.r53zoneid, r53access: conf.r53access, r53secret: conf.r53secret, nosyncwait: nosyncwait},
            cred_uniq = conf.r53zoneid + '-' + conf.r53access + '-' + conf.r53secret + '-' + conf.nosyncwait;

        batch[cred_uniq] = batch[cred_uniq] || {cred: cred, records: []}; // initialize if different

        // get all the read instances
        dbInfo.read.forEach(function(info, i) {
          if (typeof info.ip !== 'undefined' && typeof info.host !== 'undefined') {
            batch[cred_uniq].records.push({host: conf.r53readpre + '-' + (i + 1) + '.' + conf.r53domain, ip: info.ip, ttl: conf.timetolive});
          }
        })

        // get all the write instances
        dbInfo.write.forEach(function(info, i) {
          if (typeof info.ip !== 'undefined' && typeof info.host !== 'undefined') {
            batch[cred_uniq].records.push({host: conf.r53writepre + '-' + (i + 1) + '.' + conf.r53domain, ip: info.ip, ttl: conf.timetolive});
          }
        })

        // only process once we have everything
        if (cconfs.length == 0) {
          // write the r53 records
          setRoute53Records(batch, function(r53, changeID) {
            console.log('Done');
          });
        } else {
          addClusterInfo();
        }
      } catch (e) {
        console.error(e);
      }
    });
  })();
})

function processConfs(cb) {
  var fs      = require('fs'),
      program = require('commander'),
      cliarg  = process.argv[2],
      confs   = [],
      conf, files;

  if (cliarg !== undefined) {
    if (fs.existsSync(cliarg)) {
      if (fs.lstatSync(cliarg).isDirectory()) {
        files = fs.readdirSync(cliarg);

        // aggregate into zone id batches
        for (var i = 0; i < files.length; i++) {
          if (files[i].match(/^(.*)\.json$/)) {
            conf = require(absPath(cliarg + '/' + files[i]));
            confs.push(conf);
          }
        }
      } else if (fs.lstatSync(cliarg).isFile() && (cliarg.match(/^(.*)\.json$/))) {
        conf = require(absPath(cliarg));
        confs.push(conf);
      }
    } else {
      program
        .version('1.0')
        .description('Create Route 53 DNS Entries for VPC peered DB Clusters')
        .option('-a, --r53access [value]',    'AWS Route 53 account Access Key ID ')
        .option('-s, --r53secret [value]',    'AWS Route 53 account Secret Access Key')
        .option('-z, --r53zoneid [value]',    'AWS Route 53 Zone ID')
        .option('-d, --r53domain [value]',    'AWS Route 53 Domain')
        .option('-o, --r53readpre [value]',   'AWS Route 53 read-only hostname prefix')
        .option('-w, --r53writepre [value]',  'AWS Route 53 write hostname prefix')
        .option('-b, --rdsaccess [value]',    'AWS RDS account Access Key ID')
        .option('-t, --rdssecret [value]',    'AWS RDS account Secret Access Key')
        .option('-r, --rdsregion [value]',    'AWS RDS account Region')
        .option('-c, --rdscluster [value]',   'AWS RDS cluster endpoint')
        .option('-l, --lookuphost [value]',   'Host that has proper access/networking to lookup internal IP')
        .option('-u, --lookupuser [value]',   'User that has proper access/networking to lookup internal IP')
        .option('-n, --nosyncwait',           'Do not wait until DNS servers are INSYNC')
        .option('-i, --timetolive',           'DNS time to live')
        .parse(process.argv);

      confs.push({
        r53access:   program.r53access,
        r53secret:   program.r53secret,
        r53zoneid:   program.r53zoneid,
        r53domain:   program.r53domain,
        r53readpre:  program.r53readpre,
        r53writepre: program.r53writepre,
        rdsaccess:   program.rdsaccess,
        rdssecret:   program.rdssecret,
        rdsregion:   program.rdsregion,
        rdscluster:  program.rdscluster,
        lookuphost:  program.lookuphost,
        lookupuser:  program.lookupuser,
        timetolive:  program.timetolive
      });
    }
  }

  checkRequired(confs, cb);
}

// check all configs that they have the required params
function checkRequired(confs, cb) {
  var required = ['r53access', 'r53secret', 'r53zoneid', 'r53domain', 'r53readpre', 'r53writepre', 'rdsaccess', 'rdssecret', 'rdsregion', 'rdscluster', 'lookuphost', 'lookupuser'];

  confs.forEach(function(conf) {
    required.forEach(function(req) {
      if (!conf[req]) {
        throw new Error('--' + req + ' missing, it is required');
      }
    });
  });

  cb(confs);
}

// don't release until DNS is synced
function r53WaitForSync(r53, changeID, cb) {
  r53.getChange({Id: changeID}, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      if (data.ChangeInfo.Status == 'PENDING') {
        console.log(changeID + ' - ' + data.ChangeInfo.Status);
        setTimeout(function() {
          r53WaitForSync(r53, changeID, cb);
        }, 2500);
      } else {
        cb(data.ChangeInfo.Status);
      }
    }
  });
}

function getAWS(conf) {
  var aws = require('aws-sdk');

  aws.config.update(conf);

  return aws;
}

// send a upsert call to enter the DNS records
function setRoute53Records(batch, cb) {
  Object.keys(batch).forEach(function(cred_uniq) {
    var cred    = batch[cred_uniq].cred,
        records = batch[cred_uniq].records,
        aws     = getAWS({accessKeyId: cred.r53access, secretAccessKey: cred.r53secret}),
        r53     = new aws.Route53(),
        params  = {ChangeBatch: {Changes: []}, HostedZoneId: cred.r53zoneid}; // setup base params

    // gather up all the records for the batch
    records.forEach(function(record) {
      params.ChangeBatch.Changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: record.host,
          Type: 'A',
          TTL: record.ttl,
          ResourceRecords: [{Value: record.ip}]
        }
      })
    });

    if (params.ChangeBatch.Changes.length > 0) {
      r53.changeResourceRecordSets(params, function(err, data) {
        if (err) {
          console.log(err, err.stack); // an error occurred
        } else {
          if (cred.nosyncwait) {
            console.log('\nChanges sent to Route 53, not waiting for DNS sync: ' + data.ChangeInfo.Id);
            cb();
          } else {
            console.log('\nSending changes to Route 53, waiting for DNS sync');

            r53WaitForSync(r53, data.ChangeInfo.Id, function(status) {
              console.log(data.ChangeInfo.Id + ' - ' + status);
              cb();
            });
          }
        }
      });
    }
  });
}

// get the overall cluster information
function getDBClustersSummary(conf, cb) {
  var aws           = getAWS({accessKeyId: conf.rdsaccess, secretAccessKey: conf.rdssecret, region: conf.rdsregion}),
      rds           = new aws.RDS(),
      rdsInstances  = {read: [], write: [], instances: []};

  rds.describeDBClusters({}, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      if (data.hasOwnProperty('DBClusters')) {
        for (var i = 0; i < data.DBClusters.length; i++) {
          if (data.DBClusters[i].hasOwnProperty('DBClusterMembers') && data.DBClusters[i].hasOwnProperty('Endpoint') && data.DBClusters[i].Endpoint == conf.rdscluster) {
            for (var j = 0; j < data.DBClusters[i].DBClusterMembers.length; j++) {
              var kind = data.DBClusters[i].DBClusterMembers[j].IsClusterWriter ? 'write' : 'read';

              var info = {
                name: data.DBClusters[i].DBClusterMembers[j].DBInstanceIdentifier,
                kind: kind
              };

              console.log('Cluster ' + kind + ' instance : ' + info.name);

              rdsInstances.instances[data.DBClusters[i].DBClusterMembers[j].DBInstanceIdentifier] = info;

              rdsInstances[kind].push(info);
            }
          }
        }

        getDBInstancesSummary(conf, rds, rdsInstances, cb);
      } else {
        console.log('Count not reference data.DBClusters[i].DBClusterMembers');
      }
    }
  });
}

// get the cluster instances information
function getDBInstancesSummary(conf, rds, rdsInstances, cb) {
  rds.describeDBInstances({}, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      for (var i = 0; i < data.DBInstances.length; i++) {
        if (
          data.DBInstances[i].hasOwnProperty('DBInstanceIdentifier') &&
          data.DBInstances[i].hasOwnProperty('Endpoint') &&
          data.DBInstances[i].Endpoint.hasOwnProperty('Address') &&
          rdsInstances.instances.hasOwnProperty(data.DBInstances[i].DBInstanceIdentifier)
        ) {
          var host  = data.DBInstances[i].Endpoint.Address,
              ip;

          try {
            ip    = getLocalIPFromHost(host, conf.lookuphost, conf.lookupuser);

            console.log('Cluster Instance ' + host + ' ip : ' + ip);

            rdsInstances.instances[data.DBInstances[i].DBInstanceIdentifier].host = host;
            rdsInstances.instances[data.DBInstances[i].DBInstanceIdentifier].ip   = ip;
          } catch (err) {
            console.error(err);
          }
        }
      }

      cb(rdsInstances);
    }
  });
}

function exitHandler(options, err) {
  if (options.cleanup) {
    removePID();
  }

  if (err) {
    console.log(err.stack);
  }

  if (options.exit) {
    console.log('User interuption');

    removePID();

    process.exit();
  }
}

// unlink
function removePID() {
  var fs  = require('fs');

  fs.unlink(pidfile);
}

function writePID() {
  var fs  = require('fs'),
      pid = process.pid,
      fd  = fs.openSync(pidfile, 'wx');

  fs.writeFileSync(pidfile, pid.toString());

  fs.closeSync(fd);
}

// return the path that will work with a require()
function absPath(filepath) {
  return filepath.match(/^[\/~]/) ? filepath : require('path').join(process.cwd(), filepath);
}

// function to issue on the host to get a IP for the host, "getent" which should be available on most linux systems
function getLocalIPFromHost(address, host, user) {
  var execSync  = require('child_process').execSync,
      hostInfo  = execSync('ssh -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no ' + user + '@' + host + ' getent hosts "' + address + '"', {encoding: 'utf8'});

  // crude way to only get the IP address
  return hostInfo.replace(/^((?:[0-9]{1,3}\.){3}[0-9]{1,3}).*\n*/m, '$1');
}
