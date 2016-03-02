var program   = require('commander'),
    r53AWS    = require('aws-sdk'),
    rdsAWS    = require('aws-sdk'),
    execSync  = require('child_process').execSync,
    rds;

main();

function main() {
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

  if (!program.r53access)   throw new Error('--r53access required');
  if (!program.r53secret)   throw new Error('--r53secret required');
  if (!program.r53zoneid)   throw new Error('--r53zoneid required');
  if (!program.r53domain)   throw new Error('--r53domain required');
  if (!program.r53readpre)  throw new Error('--r53readpre required');
  if (!program.r53writepre) throw new Error('--r53writepre required');
  if (!program.rdsaccess)   throw new Error('--rdsaccess required');
  if (!program.rdssecret)   throw new Error('--rdssecret required');
  if (!program.rdsregion)   throw new Error('--rdsregion required');
  if (!program.rdscluster)  throw new Error('--rdscluster required');
  if (!program.lookuphost)  throw new Error('--lookuphost required');
  if (!program.lookupuser)  throw new Error('--lookupuser required');

  rdsAWS.config.update({accessKeyId: program.rdsaccess, secretAccessKey: program.rdssecret, region: program.rdsregion});
  rds = new rdsAWS.RDS();

  r53AWS.config.update({accessKeyId: program.r53access, secretAccessKey: program.r53secret});
  r53 = new r53AWS.Route53();

  getDBClustersSummary(function(dbInfo) {
    setRoute53Records(dbInfo, function(changeID) {
      if (program.nosyncwait) {
        console.log('Changes sent to Route 53, not waiting for sync: ' + changeID);
      } else {
        r53WaitForSync(changeID, function(status) {
          console.log(changeID + ' - ' + status);
        });
      }
    });
  });
}

// set interval for status
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

function setRoute53Records(dbInfo, cb) {
  // setup base params
  var params = {
        ChangeBatch: {
          Changes: []
        },
        HostedZoneId: program.r53zoneid
      };

  if (dbInfo.hasOwnProperty('read')) {
    for (var i = 0; i < dbInfo.read.length; i++) {
      params.ChangeBatch.Changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: program.r53readpre + '-' + (i + 1) + '.' + program.r53domain,
          Type: 'A',
          TTL: 300,
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
          Name: program.r53writepre + '-' + (i + 1) + '.' + program.r53domain,
          Type: 'A',
          TTL: 300,
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

function getDBClustersSummary(cb) {
  var rdsInstances = {'read' : [], 'write' : [], 'instances' : []};

  rds.describeDBClusters({}, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      if (data.hasOwnProperty('DBClusters')) {
        for (var i = 0; i < data.DBClusters.length; i++) {
          if (data.DBClusters[i].hasOwnProperty('DBClusterMembers') && data.DBClusters[i].hasOwnProperty('Endpoint') && data.DBClusters[i].Endpoint == program.rdscluster) {
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

        getDBInstancesSummary(rdsInstances, cb);
      } else {
        console.log('Count not reference data.DBClusters[i].DBClusterMembers');
      }
    }
  });
}

function getDBInstancesSummary(rdsInstances, cb) {
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
          rdsInstances.instances[data.DBInstances[i].DBInstanceIdentifier].ip = getLocalIPFromHost(address, program.lookuphost, program.lookupuser);
        }
      }

      cb(rdsInstances);
    }
  });
}

function getLocalIPFromHost(address, host, user) {
  // use "getent" which should be available on most linux systems
  var hostInfo = execSync('ssh ' + user + '@' + host + ' getent hosts "' + address + '"', {encoding: 'utf8'});

  // crude way to only get the IP address
  return hostInfo.replace(/^((?:[0-9]{1,3}\.){3}[0-9]{1,3}).*\n*/m, '$1');
}