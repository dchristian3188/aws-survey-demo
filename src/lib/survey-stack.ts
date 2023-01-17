import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { aws_opensearchservice as opensearch } from 'aws-cdk-lib';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { aws_cognito as cognito } from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DynamoDBSeeder, Seeds } from '@cloudcomponents/cdk-dynamodb-seeder';


export class SurveyDemo extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);



    //Cognito User Pools
    const stackID = cdk.Stack.of(this).stackName.split("-")[3] //TODO This doesnt work
    const surveyUserPool = new cognito.UserPool(this, 'survey-UserPool');
    
    surveyUserPool.addDomain("surveys",{
      cognitoDomain: {
        domainPrefix: "surveys-" + stackID 
      }
    })

 
    //Cognito Identity Pool Setup 
    const surveyIdentityPool = new cognito.CfnIdentityPool(this, 'survey-IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: []
    })  

    const surveyAdminUserRole = new iam.Role(this, "survey-AdminUserRole", {
      assumedBy:
        new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
          "StringEquals": { "cognito-identity.amazonaws.com:aud": surveyIdentityPool.ref },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated"
          }
        }, "sts:AssumeRoleWithWebIdentity")
    });

    surveyAdminUserRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonOpenSearchServiceFullAccess"))

    const surveyIdentityPoolAttachment = new cognito.CfnIdentityPoolRoleAttachment(this,'Survey-IdentityPoolAttachment',{
      identityPoolId: surveyIdentityPool.ref,
      roles:{
        'authenticated': surveyAdminUserRole.roleArn
      }
    })

    // Cognito Groups and Roles
    const opensearchRole = new iam.Role(this, "survey-EsRole", {
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonOpenSearchServiceCognitoAccess")
      ]});

    const surveyCognitoAdminGroup = new cognito.CfnUserPoolGroup(this,"survey-CognitoAdminGroup",{
      userPoolId: surveyUserPool.userPoolId,
      groupName: "opensearch-admin",
      roleArn: surveyAdminUserRole.roleArn
    })

    //Opensearch
    const surveyOpensearchDomain = new opensearch.Domain(this, 'survey-Domain', {
      domainName: "surveys",
      version: opensearch.EngineVersion.OPENSEARCH_1_3,
      enableVersionUpgrade: true,
      cognitoDashboardsAuth: {
        identityPoolId: surveyIdentityPool.ref,
        role: opensearchRole,
        userPoolId: surveyUserPool.userPoolId
      }
    })

    // S3
    const surveyBucket = new cdk.aws_s3.Bucket(this, 'survey-Bucket', {})

    // Lambda
    const surveyLambda = new PythonFunction(this, "survey-TextractLambda", {
      entry: "./lambda-Textract",
      runtime: lambda.Runtime.PYTHON_3_9,
      timeout: cdk.Duration.seconds(15)
    })

    //TODO can we scope these ?
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "TextractManagedPolicy", "arn:aws:iam::aws:policy/AmazonTextractFullAccess"))
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "S3ManagedPolicy", "arn:aws:iam::aws:policy/AmazonS3FullAccess"))

    // Kinesis
    const surveyKinesisStream = new cdk.aws_kinesis.Stream(this,"survey-KinesisStream",{})

    // Kinesis Firehose Role
    const surveyKinesisFirehoseRole = new iam.Role(this,"survey-KinesisFirehoseRole",{
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com')
    })

    surveyKinesisFirehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions:["es:*"],
        resources:["*"]
      })
    )

    surveyKinesisFirehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions:["kinesis:*"],
        resources:[surveyKinesisStream.streamArn]
      })
    )

    surveyKinesisFirehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions:["s3:*"],
        resources:[
          surveyBucket.bucketArn,
          `${surveyBucket.bucketArn}/*`
        ]
      })
    )

    // Kinesis Firehose to tie data stream and opensearch together
     const surveyKinesisFirehose = new cdk.aws_kinesisfirehose.CfnDeliveryStream(this,"survey-KinesisFirehose",{
       kinesisStreamSourceConfiguration: {
         kinesisStreamArn: surveyKinesisStream.streamArn,
         roleArn: surveyKinesisFirehoseRole.roleArn
       },
       amazonopensearchserviceDestinationConfiguration:{
        domainArn: surveyOpensearchDomain.domainArn,
        indexName: "surveys",
        indexRotationPeriod: "NoRotation",
        s3Configuration:{
          bucketArn: surveyBucket.bucketArn,
          prefix: "kinesis-firehose-errors/",
          roleArn: surveyKinesisFirehoseRole.roleArn
        },
        roleArn: surveyKinesisFirehoseRole.roleArn,
        cloudWatchLoggingOptions: {
          enabled: true
        }
       },
   })



    const surveyDynamoDBTable = new cdk.aws_dynamodb.Table(this, 'survey-Questions', {
      partitionKey: {
        name: "ID",
        type: cdk.aws_dynamodb.AttributeType.STRING
      }
    })

    const surveyDynamoDBSeeder = new DynamoDBSeeder(this,"surveyDynamoDBSeeder",{
        table: surveyDynamoDBTable,
        seeds: Seeds.fromJsonFile(path.join(__dirname, '..', 'survey-Data/questions.json'))
      })

    new cdk.CfnOutput(this, 'bucketName', {
      value: surveyBucket.bucketName,
      description: "Bucket to upload surveys to",
      exportName: 'surveyBucket'
    })
  }
}
