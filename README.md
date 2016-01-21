# rds-cluster-route53-records
Create Route 53 DNS Entries for VPC peered DB Clusters

Currently AWS does not allow a VPC in a peered connection to be able to see the internal IP addresses of RDS clusters in the other peered VPC. In order to be able to use the proper read or write instance in a RDS cluster, you would need to target the IP addresses. In a clustered environment this is subject to change during maintenance or failover. 

This is a crude Node.js program to get the most recent readers and writers in a cluster and will make Route 53 records accordingly

Here is example usage:

node rds-cluster-route53-records.js \
  --r53access R53_ACCESS_KEY_ID \
  --r53secret R53_SECRET_ACCESS_KEY \
  --r53zoneid R53_ZONE_ID \
  --r53domain R53_DOMAINNAME \
  --r53readpre db-read \
  --r53writepre db-write \
  --rdsaccess RDS_ACCESS_KEY_ID \
  --rdssecret RDS_SECRET_ACCESS_KEY \
  --rdsregion RDS_REGION \
  --rdscluster rds.cluster.domainname.com \
  --lookuphost ec2.instance.domainname.com \
  --lookupuser centos \
