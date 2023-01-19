import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { Fn } from 'aws-cdk-lib';
import { aws_opensearchservice as opensearch } from 'aws-cdk-lib';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { aws_cognito as cognito } from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import {aws_s3_deployment as s3deploy } from 'aws-cdk-lib'
import { aws_s3_notifications as s3notifications } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DynamoDBSeeder, Seeds } from '@cloudcomponents/cdk-dynamodb-seeder';

export interface SurveyDemoProps {
  Prefix: string
}


export class SurveyDemo extends cdk.Stack {
  constructor(scope: Construct, id: string, surveyProps: SurveyDemoProps, props?: cdk.StackProps) {
    super(scope, id, props);



    //Cognito User Pools
    const surveyUserPool = new cognito.UserPool(this, 'survey-UserPool');

    // get a unique suffix from the last element of the stackId, e.g. 06b321d6b6e2
    const suffix = Fn.select(4, Fn.split("-", Fn.select(2, Fn.split("/", this.stackId))));

    surveyUserPool.addDomain("surveys", {
      cognitoDomain: {
        domainPrefix: (surveyProps.Prefix + "-" + suffix)
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

    const surveyIdentityPoolAttachment = new cognito.CfnIdentityPoolRoleAttachment(this, 'Survey-IdentityPoolAttachment', {
      identityPoolId: surveyIdentityPool.ref,
      roles: {
        'authenticated': surveyAdminUserRole.roleArn
      }
    })

    // Cognito Groups and Roles
    const opensearchRole = new iam.Role(this, "survey-EsRole", {
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonOpenSearchServiceCognitoAccess")
      ]
    });

    const surveyCognitoAdminGroup = new cognito.CfnUserPoolGroup(this, "survey-CognitoAdminGroup", {
      userPoolId: surveyUserPool.userPoolId,
      groupName: "opensearch-admin",
      roleArn: surveyAdminUserRole.roleArn
    })

    //Opensearch
    const surveyOpensearchDomain = new opensearch.Domain(this, 'survey-Domain', {
      domainName: surveyProps.Prefix,
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

    // Kinesis Firehose Role
    const surveyKinesisFirehoseRole = new iam.Role(this, "survey-KinesisFirehoseRole", {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com')
    })

    surveyKinesisFirehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["es:*"],
        resources: ["*"]
      })
    )

    surveyKinesisFirehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:*"],
        resources: [
          surveyBucket.bucketArn,
          `${surveyBucket.bucketArn}/*`
        ]
      })
    )

    // Kinesis Firehose to tie data stream and opensearch together
    const surveyKinesisFirehose = new cdk.aws_kinesisfirehose.CfnDeliveryStream(this, "survey-KinesisFirehose", {
      amazonopensearchserviceDestinationConfiguration: {
        domainArn: surveyOpensearchDomain.domainArn,
        indexName: "surveys",
        indexRotationPeriod: "NoRotation",
        s3Configuration: {
          bucketArn: surveyBucket.bucketArn,
          prefix: "kinesis-firehose-errors/",
          roleArn: surveyKinesisFirehoseRole.roleArn
        },
        roleArn: surveyKinesisFirehoseRole.roleArn,
      },
    })

    // DyanmoDB
    const surveyDynamoDBTable = new cdk.aws_dynamodb.Table(this, 'survey-Questions', {
      partitionKey: {
        name: "ID",
        type: cdk.aws_dynamodb.AttributeType.STRING
      }
    })

    const surveyDynamoDBSeeder = new DynamoDBSeeder(this, "surveyDynamoDBSeeder", {
      table: surveyDynamoDBTable,
      seeds: Seeds.fromJsonFile(path.join(__dirname, '..', 'survey-Data/questions.json'))
    })

    // Lambda
    const surveyLambda = new PythonFunction(this, "survey-TextractLambda", {
      entry: "./lambda-Textract",
      runtime: lambda.Runtime.PYTHON_3_9,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DYNAMODB_TABLENAME: surveyDynamoDBTable.tableName,
        SURVEY_KEY: "survey", //must match the ID from questions
        FIREHOSE_STREAM: surveyKinesisFirehose.ref
      }
    })

    //TODO can we scope these ?
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "TextractManagedPolicy", "arn:aws:iam::aws:policy/AmazonTextractFullAccess"))
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "S3ManagedPolicy", "arn:aws:iam::aws:policy/AmazonS3FullAccess"))
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "DynamoDBReadOnly", "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess"))
    surveyLambda.role?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "Firehose", "arn:aws:iam::aws:policy/AmazonKinesisFirehoseFullAccess"))

    const surveyBucketSetup = new s3deploy.BucketDeployment(this,"survey-BucketSetup",{
      destinationBucket: surveyBucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'survey-Data/bucket_config'))
      ]
    })

    const surveyS3notification = new s3notifications.LambdaDestination(surveyLambda)
    surveyBucket.addObjectCreatedNotification(surveyS3notification, {
      prefix: "input/",
      suffix: ".png"
    })
    surveyBucket.addObjectCreatedNotification(surveyS3notification, {
      prefix: "input/",
      suffix: ".jpeg"
    })
    surveyBucket.addObjectCreatedNotification(surveyS3notification, {
      prefix: "input/",
      suffix: ".pdf"
    })

    new cdk.CfnOutput(this, 'bucketName', {
      value: surveyBucket.bucketName,
      description: "Bucket to upload surveys to",
      exportName: 'surveyBucket'
    })

    new cdk.CfnOutput(this, 'createUserUrl', {
      description: "Create a new user in the user pool here",
      value: "https://" + this.region + ".console.aws.amazon.com/cognito/users?region=" + this.region + "#/pool/" + surveyUserPool.userPoolId + "/users"
    });

    new cdk.CfnOutput(this, 'opensearchUrl', {
      description: "Access OpenSearch via this URL.",
      value: "https://" + surveyOpensearchDomain.domainEndpoint + "/_dashboards"
    });

  }
}
