# AWS Cloud Development Kit (AWS CDK)

This is a branch to experiment with refactoring support for the CDK. The 
idea is to try to preserve the old logical IDs of the CloudFormation 
resources whenever they are moved from one place to another in the construct 
tree. 

There are basically two kinds of changes a user can do: move and modify the 
resource properties. When these changes are done one at a time, it's 
possible to detect automatically and take the necessary action. If a 
resource was moved but not modified, its hash (which we are now computing 
for every resource) didn't change; so we use the old ID. If the resource was 
modified but not moved, the structure of the tree will not change, so we 
don't need to do anything extra. Also, if the tree only gained or only lost 
nodes, we don't need to any additional work either.

The problematic case is when both types of changes occur at the same time: 
when a user moves and modifies a resource. In that case, we ask the user for 
guidance on how to do the refactoring. For each resource type, we present 
the user with the list of resources that were removed and the list of 
resources that were added for that type. The user then tells the CDK which 
removed resources correspond to which added resources. If the intention was 
to actually remove and add a resource (rather than refactor one into the 
other), the user can also say that, in which case, the CDK does its normal 
job, generating a new ID for the added resource.