"use strict";

// TODO: daemonize/set interval
// TODO: write/honor PID file to avoic cron colision
// TODO: optional TTL for DNS records
// TODO: check existing record and if no chenge needed, don't update

processConfs(function(confs) {
  Object.keys(confs).forEach(function(key) {
    var conf      = confs[key],
        r53AWS    = require('aws-sdk'),
        rdsAWS    = require('aws-sdk'),
        rds, r53;

    rdsAWS.config.update({accessKeyId: conf.rdsaccess, secretAccessKey: conf.rdssecret, region: conf.rdsregion});
    rds = new rdsAWS.RDS();

    r53AWS.config.update({accessKeyId: conf.r53access, secretAccessKey: conf.r53secret});
    r53 = new r53AWS.Route53();

    getDBClustersSummary(conf, rds, function(dbInfo) {
      setRoute53Records(conf, dbInfo, function(changeID) {
        if (conf.nosyncwait) {
          console.log('Changes sent to Route 53, not waiting for sync: ' + changeID);
        } else {
          r53WaitForSync(changeID, function(status) {
            console.log(changeID + ' - ' + status);
          });
        }
      });
    });
  });
})

function processConfs(cb) {
  var fs      = require('fs'),
      program = require('commander'),
      cliarg  = process.argv[2],
      confs   = {},
      files, found;

  if (cliarg !== undefined) {
    if (fs.existsSync(cliarg)) {
      if (fs.lstatSync(cliarg).isDirectory()) {
        files = fs.readdirSync(cliarg);

        for (var i = 0; i < files.length; i++) {
          if (found = files[i].match(/^(.*)\.json$/)) {
            confs[found[1]] = require(absPath(cliarg + '/' + files[i]));
          }
        }
      } else if (fs.lstatSync(cliarg).isFile() && (found = cliarg.match(/^(.*)\.json$/))) {
        confs[found[1]] = require(absPath(cliarg));
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
        .parse(process.argv);

      confs = {
        'arguments' : {
          'r53access'   : program.r53access,
          'r53secret'   : program.r53secret,
          'r53zoneid'   : program.r53zoneid,
          'r53domain'   : program.r53domain,
          'r53readpre'  : program.r53readpre,
          'r53writepre' : program.r53writepre,
          'rdsaccess'   : program.rdsaccess,
          'rdssecret'   : program.rdssecret,
          'rdsregion'   : program.rdsregion,
          'rdscluster'  : program.rdscluster,
          'lookuphost'  : program.lookuphost,
          'lookupuser'  : program.lookupuser
        }
      };
    }
  }

  checkRequired(confs, cb);
}

// check all configs that they have the required params
function checkRequired(confs, cb) {
  var required = ['r53access', 'r53secret', 'r53zoneid', 'r53domain', 'r53readpre', 'r53writepre', 'rdsaccess', 'rdssecret', 'rdsregion', 'rdscluster', 'lookuphost', 'lookupuser'];

  for (var i = 0; i < confs.length; i++) {
    for (var j = 0; j < required.length; j++) {
      if (!confs[i].hasOwnProperty[required[j]]) {
        throw new Error('--' + required[j] + ' missing, it is required');
      }
    }
  }

  cb(confs);
}

// don't release until DNS is synced
function r53WaitForSync(changeID, cb) {
  r53.getChange({Id: changeID}, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      if (data.ChangeInfo.Status == 'PENDING') {
        console.log(changeID + ' - ' + data.ChangeInfo.Status);
        setTimeout(function() {
          r53WaitForSync(changeID, cb);
        }, 2500);
      } else {
        cb(data.ChangeInfo.Status);
      }
    }
  });
}

// send a upsert call to enter the DNS records
function setRoute53Records(conf, dbInfo, cb) {
  var ttl = conf.ttl && Number.isInteger(conf.ttl) ? conf.ttl : 300;

  // setup base params
  var params = {
        ChangeBatch: {
          Changes: []
        },
        HostedZoneId: conf.r53zoneid
      };

  if (dbInfo.hasOwnProperty('read')) {
    for (var i = 0; i < dbInfo.read.length; i++) {
      params.ChangeBatch.Changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: conf.r53readpre + '-' + (i + 1) + '.' + conf.r53domain,
          Type: 'A',
          TTL: ttl,
          ResourceRecords: [{
              'Value': dbInfo.read[i].ip
          }]
        }
      });
    }
  }

  if (dbInfo.hasOwnProperty('write')) {
    for (var i = 0; i < dbInfo.write.length; i++) {
      params.ChangeBatch.Changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: conf.r53writepre + '-' + (i + 1) + '.' + conf.r53domain,
          Type: 'A',
          TTL: ttl,
          ResourceRecords: [{
              'Value': dbInfo.write[i].ip
          }]
        }
      });
    }
  }

  console.log(require('util').inspect(params, {showHidden: false, depth: null}));

  if (params.ChangeBatch.Changes.length > 0) {
    r53.changeResourceRecordSets(params, function(err, data) {
      if (err) {
        console.log(err, err.stack); // an error occurred
      } else {
        cb(data.ChangeInfo.Id);
      }
    });
  }
}

// get the overall cluster information
function getDBClustersSummary(conf, rds, cb) {
  var rdsInstances = {'read' : [], 'write' : [], 'instances' : []};

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
                'name' : data.DBClusters[i].DBClusterMembers[j].DBInstanceIdentifier,
                'kind' : kind
              };

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
          var address = data.DBInstances[i].Endpoint.Address;

          rdsInstances.instances[data.DBInstances[i].DBInstanceIdentifier].host = address;
          rdsInstances.instances[data.DBInstances[i].DBInstanceIdentifier].ip = getLocalIPFromHost(address, conf.lookuphost, conf.lookupuser);
        }
      }

      cb(rdsInstances);
    }
  });
}

// return the path that will work with a require()
function absPath(filepath) {
  return filepath.match(/^[\/~]/) ? filepath : require('path').join(process.cwd(), filepath);
}

// function to issue on the host to get a IP for the host
function getLocalIPFromHost(address, host, user) {
  var execSync  = require('child_process').execSync,
      hostInfo = execSync('ssh ' + user + '@' + host + ' getent hosts "' + address + '"', {encoding: 'utf8'}); // use "getent" which should be available on most linux systems

  // crude way to only get the IP address
  return hostInfo.replace(/^((?:[0-9]{1,3}\.){3}[0-9]{1,3}).*\n*/m, '$1');
}