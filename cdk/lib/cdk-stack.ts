// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs/lib";
import iam = require("aws-cdk-lib/aws-iam");
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import sns = require("aws-cdk-lib/aws-sns");
import snsSubscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
import sqs = require("aws-cdk-lib/aws-sqs");
import dynamodb = require("aws-cdk-lib/aws-dynamodb");
import lambda = require("aws-cdk-lib/aws-lambda");
import s3 = require("aws-cdk-lib/aws-s3");
import apigw = require("aws-cdk-lib/aws-apigateway");
import ecs = require("aws-cdk-lib/aws-ecs");
import ec2 = require("aws-cdk-lib/aws-ec2");
import cloudfront = require("aws-cdk-lib/aws-cloudfront");
import origins = require("aws-cdk-lib/aws-cloudfront-origins");
import logs = require("aws-cdk-lib/aws-logs");
import efs = require("aws-cdk-lib/aws-efs");
import elb = require("aws-cdk-lib/aws-elasticloadbalancingv2");

interface Props extends cdk.StackProps {
  readonly stage: string;
  readonly s3ContentBucketName: string;
}

export class WuolahAiTutorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    //**********SageMaker Endpoints*********************
    const endpointSum = this.node.tryGetContext("sumEndpoint");
    const endpointEmbed = this.node.tryGetContext("embedEndpoint");
    const endpointQa = this.node.tryGetContext("qaEndpoint");

    //**********SNS Topics******************************

    // Creamos un topic para notificar la finalización de los trabajos
    const jobCompletionTopic = new sns.Topic(this, "JobCompletion", {
      topicName: `${props.stage}-wuolah-ai-tutor-job-completion-topic`,
    });

    //**********IAM Roles******************************

    // Creamos un rol para el servicio de Textract
    const textractServiceRole = new iam.Role(this, "TextractServiceRole", {
      assumedBy: new iam.ServicePrincipal("textract.amazonaws.com"),
    });
    textractServiceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [jobCompletionTopic.topicArn],
        actions: ["sns:Publish"],
      })
    );

    //**********S3 Bucket******************************

    // Importamos el bucket de almacenamiento de documentos de wuolah
    const contentBucket = s3.Bucket.fromBucketName(
      this,
      "DocumentsBucket",
      props.s3ContentBucketName
    );
    const contentBucketResource = contentBucket.node.findChild(
      "Resource"
    ) as cdk.CfnResource;
    contentBucketResource.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Creamos el bucket de alojamiento de la aplicación
    const appBucket = new s3.Bucket(this, "AppBucket", {
      bucketName: `${props.stage}-wuolah-ai-tutor-app-bucket`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: "accesslogs",
      publicReadAccess: false,
      enforceSSL: true,
    });

    //**********DynamoDB Table*************************

    // DynamoDB table with textract output link
    // Fields = document, output type, s3 location
    const outputTable = new dynamodb.Table(this, "OutputTable", {
      tableName: `${props.stage}-wuolah-ai-tutor-output`,
      partitionKey: { name: "documentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "outputType", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
    });

    // DynamoDB table with job status info.
    // Fields = document id, job id, status, s3 location
    const documentsTable = new dynamodb.Table(this, "JobTable", {
      tableName: `${props.stage}-wuolah-ai-tutor-job`,
      partitionKey: { name: "documentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
    });

    // DynamoDB table with summarization job info.
    // Fields = document id, job id, status, summary text
    const summarizationTable = new dynamodb.Table(this, "SummarizationTable", {
      tableName: `${props.stage}-wuolah-ai-tutor-summarization`,
      partitionKey: { name: "documentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
    });

    // Table with embedding job info
    // Fields = document id, job id, status
    const embeddingTable = new dynamodb.Table(this, "EmbeddingTable", {
      tableName: `${props.stage}-wuolah-ai-tutor-embedding`,
      partitionKey: { name: "documentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
    });

    //**********SQS Queues*****************************

    // Creamos una dead letter queue
    const dlq = new sqs.Queue(this, "DLQ", {
      queueName: `${props.stage}-wuolah-ai-tutor-dlq`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.seconds(1209600),
      enforceSSL: true,
    });

    // Creamos una cola para el procesamiento de los trabajos de extracción de texto
    const jobResultsQueue = new sqs.Queue(this, "JobResults", {
      queueName: `${props.stage}-wuolah-ai-tutor-job-results-queue`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.seconds(1209600),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 50 },
      enforceSSL: true,
    });

    // Suscribimos la cola de resultados de los trabajos al topic de trabajos completados
    jobCompletionTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(jobResultsQueue)
    );

    // Creamos una cola para el procesamiento de los resúmenes
    const summarizationResultsQueue = new sqs.Queue(
      this,
      "SummarizationResults",
      {
        queueName: `${props.stage}-wuolah-ai-tutor-summarization-results-queue`,
        visibilityTimeout: cdk.Duration.seconds(900),
        enforceSSL: true,
        retentionPeriod: cdk.Duration.seconds(1209600),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 50 },
      }
    );

    // Creamos una cola para el procesamiento de los embeddings
    const embeddingQueue = new sqs.Queue(this, "EmbeddingQueue", {
      queueName: `${props.stage}-wuolah-ai-tutor-embedding-queue`,
      visibilityTimeout: cdk.Duration.seconds(900),
      enforceSSL: true,
      retentionPeriod: cdk.Duration.seconds(1209600),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 50 },
    });

    //**********Lambda Functions******************************

    // Creamos una layer con funciones de ayuda
    const helperLayer = new lambda.LayerVersion(this, "HelperLayer", {
      layerVersionName: `${props.stage}-wuolah-ai-tutor-helper-layer`,
      code: lambda.Code.fromAsset("lambda/helper"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      license: "Apache-2.0",
      description: "Helper layer.",
    });

    // Creamos una layer con utilidades de Textract
    const textractorLayer = new lambda.LayerVersion(this, "Textractor", {
      layerVersionName: `${props.stage}-wuolah-ai-tutor-textractor-layer`,
      code: lambda.Code.fromAsset("lambda/textractor"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      license: "Apache-2.0",
      description: "Textractor layer.",
    });

    // Async Job Processor (Start jobs using Async APIs)
    const asyncProcessor = new lambda.Function(this, "ASyncProcessor", {
      functionName: `${props.stage}-wuolah-ai-tutor-async-processor`,
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/asyncprocessor"),
      handler: "lambda_function.lambda_handler",
      reservedConcurrentExecutions: 1,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(60),
      environment: {
        SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
        SNS_ROLE_ARN: textractServiceRole.roleArn,
        OUTPUT_TABLE: outputTable.tableName,
        DOCUMENTS_TABLE: documentsTable.tableName,
      },
    });

    // Añadimos la capa de funciones de ayuda
    asyncProcessor.addLayers(helperLayer);

    // Permisos
    contentBucket.grantRead(asyncProcessor);
    outputTable.grantReadWriteData(asyncProcessor);
    documentsTable.grantReadWriteData(asyncProcessor);
    asyncProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [textractServiceRole.roleArn],
      })
    );
    asyncProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["textract:StartDocumentTextDetection"],
        resources: ["*"],
      })
    );
    //------------------------------------------------------------

    // Async Jobs Results Processor (actualiza el estado del job en DynamoDB y sube los resultados a S3)
    const jobResultProcessor = new lambda.Function(this, "JobResultProcessor", {
      functionName: `${props.stage}-wuolah-ai-tutor-job-result-processor`,
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/jobresultprocessor"),
      handler: "lambda_function.lambda_handler",
      memorySize: 2000,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(900),
      environment: {
        OUTPUT_TABLE: outputTable.tableName,
        DOCUMENTS_TABLE: documentsTable.tableName,
      },
    });

    // Añadimos las capas de funciones de ayuda y Textract
    jobResultProcessor.addLayers(helperLayer);
    jobResultProcessor.addLayers(textractorLayer);

    // Suscribimos la lambda a la cola de resultados de los trabajos
    jobResultProcessor.addEventSource(
      new SqsEventSource(jobResultsQueue, {
        batchSize: 1,
      })
    );

    // Configuramos los permisos
    outputTable.grantReadWriteData(jobResultProcessor);
    documentsTable.grantReadWriteData(jobResultProcessor);
    contentBucket.grantReadWrite(jobResultProcessor);
    jobResultProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "textract:GetDocumentTextDetection",
          "textract:GetDocumentAnalysis",
        ],
        resources: ["*"],
      })
    );

    //------------------------------------------------------------

    // Creamos una lambda para el procesamiento de resúmenes
    const summarizationProcessor = new lambda.Function(
      this,
      "SummarizationProcessor",
      {
        functionName: `${props.stage}-wuolah-ai-tutor-summarization-processor`,
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/summarizationprocessor"),
        handler: "lambda_function.lambda_handler",
        tracing: lambda.Tracing.ACTIVE,
        timeout: cdk.Duration.seconds(60),
        environment: {
          QUEUE_URL: summarizationResultsQueue.queueUrl,
          JOB_TABLE: summarizationTable.tableName,
        },
      }
    );

    // Añadimos la capa de funciones de ayuda
    summarizationProcessor.addLayers(helperLayer);

    // Configuramos los permisos
    summarizationResultsQueue.grantSendMessages(summarizationProcessor);
    summarizationTable.grantReadWriteData(summarizationProcessor);

    //------------------------------------------------------------

    // Creamos una lambda para el procesamiento de embeddings
    const embeddingProcessor = new lambda.Function(this, "EmbeddingProcessor", {
      functionName: `${props.stage}-wuolah-ai-tutor-embedding-processor`,
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/embeddingprocessor"),
      handler: "lambda_function.lambda_handler",
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(60),
      environment: {
        QUEUE_URL: embeddingQueue.queueUrl,
        JOB_TABLE: embeddingTable.tableName,
      },
    });

    // Se añade la capa de funciones de ayuda
    embeddingProcessor.addLayers(helperLayer);

    // Configuramos los permisos
    embeddingQueue.grantSendMessages(embeddingProcessor);
    embeddingTable.grantReadWriteData(embeddingProcessor);

    //**********API Gateway******************************

    // Creamos el log group para la API
    const prdLogGroup = new logs.LogGroup(this, "PrdLogs");

    // Creamos la API
    const api = new apigw.RestApi(this, "wuolah-sum-qa-api", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
        statusCode: 200,
      },
      deployOptions: {
        accessLogDestination: new apigw.LogGroupLogDestination(prdLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      cloudWatchRole: true,
    });

    // Creamos el endpoint para la extracción de texto del documento
    const documentResource = api.root.addResource("doctopdf");
    const pdfToText = new apigw.LambdaIntegration(asyncProcessor);
    documentResource.addMethod("POST", pdfToText);

    // Creamos el endpoint para obtener el resumen del documento
    const summarizeResource = api.root.addResource("summarize");
    const summarizeIntegration = new apigw.LambdaIntegration(
      summarizationProcessor
    );
    summarizeResource.addMethod("POST", summarizeIntegration);

    // Creamos el endpoint para obtener los text embeddings del documento
    const embeddingResource = api.root.addResource("embed");
    const embeddingIntegration = new apigw.LambdaIntegration(
      embeddingProcessor
    );
    embeddingResource.addMethod("POST", embeddingIntegration);

    // qa endpoint
    const qaResource = api.root.addResource("qa");

    //**********Fargate tasks******************************

    // Creamos una red privada virtual
    const vpc = new ec2.Vpc(this, "VPC", {
      vpcName: "wuolah-ai-tutor-vpc",
    });

    // Otorgamos acceso a S3 sin pasar por internet o NAT gateways
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Otorgamos acceso a Docker Registry APIs sin pasar por internet o NAT gateways
    vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // Otorgamos acceso al servicio KMS sin sin pasar por internet o NAT gateways
    vpc.addInterfaceEndpoint("KmsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
    });

    // Otorgamos acceso a Cloudwatch logging sin pasar por internet o NAT gateways
    vpc.addInterfaceEndpoint("CloudWatchEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    //**********ECS Cluster******************************

    // Creamos el Cluster de ECS, tipo Fargate
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false,
    });

    // Creamos la Task Definition para el worker de resúmenes
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "SummarizationWorkerTask",
      {
        memoryLimitMiB: 30720,
        cpu: 4096,
        ephemeralStorageGiB: 200,
        // Uncomment this section if running on ARM
        // runtimePlatform: {
        //   cpuArchitecture: ecs.CpuArchitecture.ARM64,
        // }
      }
    );

    // Permisos
    fargateTaskDefinition.grantRun(summarizationProcessor);
    contentBucket.grantRead(fargateTaskDefinition.taskRole);
    summarizationTable.grantReadWriteData(fargateTaskDefinition.taskRole);
    fargateTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: [
          "arn:aws:sagemaker:" +
            this.region +
            ":" +
            this.account +
            ":endpoint/" +
            endpointSum,
        ],
      })
    );

    // Definición del contenedor
    fargateTaskDefinition.addContainer("worker", {
      containerName: `${props.stage}-wuolah-ai-tutor-summarization-worker-container`,
      image: ecs.ContainerImage.fromAsset("fargate/summarizationworker"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "summarization-log-group",
        logRetention: 30,
      }),
      environment: {
        SUMMARIZATION_ENDPOINT: endpointSum,
        SUMMARIZATION_TABLE: summarizationTable.tableName,
        AWS_REGION: this.region,
      },
    });

    //**********ECS task launcher******************************

    // Listado de subnets de la vpc
    const subnetIds: string[] = [];
    vpc.privateSubnets.forEach((subnet) => {
      subnetIds.push(subnet.subnetId);
    });

    // Creamos función de lambda para disparar la tarea ECS del summarization worker
    const taskProcessor = new lambda.Function(this, "TaskProcessor", {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/taskprocessor"),
      handler: "lambda_function.lambda_handler",
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(30),
      environment: {
        target: cluster.clusterArn,
        taskDefinitionArn: fargateTaskDefinition.taskDefinitionArn,
        subnets: subnetIds.join(","),
      },
    });
    // Suscribimos la lambda a la cola de procesamiento de resúmenes
    taskProcessor.addEventSource(
      new SqsEventSource(summarizationResultsQueue, {
        batchSize: 1,
      })
    );
    // Configuramos los permisos
    taskProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [fargateTaskDefinition.taskDefinitionArn],
      })
    );
    taskProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: ["*"],
      })
    );

    //**********EFS*************************

    const fileSystem = new efs.FileSystem(this, "ChromaFileSystem", {
      fileSystemName: `${props.stage}-wuolah-ai-tutor-efs`,
      vpc: vpc,
      encrypted: true,
      enableAutomaticBackups: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, // default
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
    const accessPoint = fileSystem.addAccessPoint("LambdaAccessPoint", {
      createAcl: {
        ownerGid: "1001",
        ownerUid: "1001",
        permissions: "750",
      },
      path: "/export/lambda",
      posixUser: {
        gid: "1001",
        uid: "1001",
      },
    });

    //**********Function that uses EFS*************************

    // Creamos la definición de la tarea ECS para el worker de embeddings
    const fargateTaskDefinitionEmbed = new ecs.FargateTaskDefinition(
      this,
      "EmbedWorkerTask",
      {
        memoryLimitMiB: 8192,
        cpu: 4096,
        ephemeralStorageGiB: 100,
        // Uncomment this section if running on ARM
        // runtimePlatform: {
        //   cpuArchitecture: ecs.CpuArchitecture.ARM64,
        // }
      }
    );

    // Configuramos el volumen de EFS
    const embedVolume = {
      name: `${props.stage}-wuolah-ai-tutor-efs-embed-volume`,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    };

    // Añadimos el volumen a la definición de la tarea
    fargateTaskDefinitionEmbed.addVolume(embedVolume);

    // Configuramos los permisos
    contentBucket.grantRead(fargateTaskDefinitionEmbed.taskRole);
    embeddingTable.grantReadWriteData(fargateTaskDefinitionEmbed.taskRole);
    fargateTaskDefinitionEmbed.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: [
          "arn:aws:sagemaker:" +
            this.region +
            ":" +
            this.account +
            ":endpoint/" +
            endpointEmbed,
        ],
      })
    );

    // Creamos el contenedor
    const embedContainer = fargateTaskDefinitionEmbed.addContainer("worker", {
      image: ecs.ContainerImage.fromAsset("fargate/embeddingWorker"),
      containerName: `${props.stage}-wuolah-ai-tutor-embedding-worker-container`,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "embed-log-group",
        logRetention: 30,
      }),
      environment: {
        EMBED_ENDPOINT: endpointSum,
        EMBED_TABLE: summarizationTable.tableName,
        AWS_REGION: this.region,
        MOUNTPOINT: "/efs/data",
      },
    });

    // Añadimos el volumen al contenedor
    embedContainer.addMountPoints({
      containerPath: "/efs/data",
      readOnly: false,
      sourceVolume: `${props.stage}-wuolah-ai-tutor-efs-embed-volume`,
    });

    // Configuramos los permisos
    fargateTaskDefinitionEmbed.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "elasticfilesystem:ClientRootAccess",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:DescribeMountTargets",
        ],
        resources: [fileSystem.fileSystemArn],
      })
    );
    fargateTaskDefinitionEmbed.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeAvailabilityZones"],
        resources: ["*"],
      })
    );
    fileSystem.connections.allowDefaultPortFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock)
    );

    // Creamos la función lambda para lanzar la tarea ECS del worker de embeddings
    const embeddingWorker = new lambda.Function(this, "EmbeddingWorker", {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/embeddingworker"),
      handler: "lambda_function.lambda_handler",
      tracing: lambda.Tracing.ACTIVE,
      memorySize: 1024,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(30),
      environment: {
        target: cluster.clusterArn,
        taskDefinitionArn: fargateTaskDefinitionEmbed.taskDefinitionArn,
        subnets: subnetIds.join(","),
      },
    });

    // Suscribimos la lambda a la cola de procesamiento de embeddings
    embeddingWorker.addEventSource(
      new SqsEventSource(embeddingQueue, {
        batchSize: 1,
      })
    );

    // Configuramos los permisos
    embeddingWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [fargateTaskDefinitionEmbed.taskDefinitionArn],
      })
    );
    embeddingWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: ["*"],
      })
    );

    //**********ECS Service for QA******************************

    // Creamos la definición de la tarea ECS para el worker de QA
    const fargateTaskDefinitionQa = new ecs.FargateTaskDefinition(
      this,
      "QaWorkerTask",
      {
        memoryLimitMiB: 8192,
        cpu: 4096,
        ephemeralStorageGiB: 100,
        // Uncomment this section if running on ARM
        // runtimePlatform: {
        //   cpuArchitecture: ecs.CpuArchitecture.ARM64,
        // }
      }
    );

    // Configuramos el volumen de EFS
    const qaVolume = {
      name: `${props.stage}-wuolah-ai-tutor-efs-qa-volume`,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    };

    // Añadimos el volumen a la definición de la tarea
    fargateTaskDefinitionQa.addVolume(qaVolume);

    // Configuramos los permisos
    fargateTaskDefinitionQa.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: [
          "arn:aws:sagemaker:" +
            this.region +
            ":" +
            this.account +
            ":endpoint/" +
            endpointEmbed,
          "arn:aws:sagemaker:" +
            this.region +
            ":" +
            this.account +
            ":endpoint/" +
            endpointQa,
        ],
      })
    );

    // Creamos el contenedor de Q&A
    const qaContainer = fargateTaskDefinitionQa.addContainer("qaworker", {
      image: ecs.ContainerImage.fromAsset("fargate/qaWorker"),
      containerName: `${props.stage}-wuolah-ai-tutor-qa-worker-container`,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "qa-log-group",
        logRetention: 30,
      }),
      portMappings: [
        {
          containerPort: 5000,
          hostPort: 5000,
        },
      ],
      environment: {
        EMBED_ENDPOINT: endpointEmbed,
        QA_ENDPOINT: endpointQa,
        MOUNTPOINT: "/efs/data",
      },
      essential: true,
    });

    // Añadimos el volumen al contenedor
    qaContainer.addMountPoints({
      containerPath: "/efs/data",
      readOnly: false,
      sourceVolume: `${props.stage}-wuolah-ai-tutor-efs-qa-volume`,
    });

    // Configuramos los permisos
    fargateTaskDefinitionQa.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "elasticfilesystem:ClientRootAccess",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:DescribeMountTargets",
        ],
        resources: [fileSystem.fileSystemArn],
      })
    );
    fargateTaskDefinitionQa.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeAvailabilityZones"],
        resources: ["*"],
      })
    );

    // Creamos el security group para el servicio
    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      "svcSecurityGroup",
      {
        vpc: vpc,
        securityGroupName: `${props.stage}-wuolah-ai-tutor-qa-svc-sg`,
      }
    );
    serviceSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5000),
      "Allow inbound traffic from resources in vpc"
    );

    // Creamos el servicio de Q&A
    const qaService = new ecs.FargateService(this, "qaService", {
      serviceName: `${props.stage}-wuolah-ai-tutor-qa-service`,
      cluster: cluster,
      desiredCount: 1,
      securityGroups: [serviceSecurityGroup],
      taskDefinition: fargateTaskDefinitionQa,
      healthCheckGracePeriod: cdk.Duration.seconds(300),
    });

    // Creamos el NLB para el servicio de QA
    const qaNLB = new elb.NetworkLoadBalancer(this, "qaNLB", {
      loadBalancerName: `${props.stage}-wuolah-ai-tutor-qa-nlb`,
      vpc: vpc,
      crossZoneEnabled: true,
      internetFacing: false,
    });

    // Creamos el target group para el servicio de QA
    const qaTargetGroup = new elb.NetworkTargetGroup(this, "qaTargetGroup", {
      targetGroupName: "qaTargetGroup",
      vpc: vpc,
      port: 5000,
      targets: [qaService],
    });
    qaTargetGroup.configureHealthCheck({
      path: "/health",
      protocol: elb.Protocol.HTTP,
      port: "5000",
    });
    qaNLB.addListener("qaTargetGroupListener", {
      port: 80,
      defaultTargetGroups: [qaTargetGroup],
    });

    // Creamos el endpoint de procesamiento de embeddings
    const link = new apigw.VpcLink(this, "link", {
      targets: [qaNLB],
    });
    const qaIntegration = new apigw.Integration({
      type: apigw.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: "POST",
      options: {
        connectionType: apigw.ConnectionType.VPC_LINK,
        vpcLink: link,
      },
    });
    qaResource.addMethod("POST", qaIntegration);

    //**********CloudFront******************************
    const distribution = new cloudfront.Distribution(this, "appdist", {
      defaultBehavior: { origin: new origins.S3Origin(appBucket) },
      enableLogging: true,
      logBucket: contentBucket,
      logFilePrefix: "distribution-access-logs/",
      logIncludesCookies: true,
      geoRestriction: cloudfront.GeoRestriction.allowlist("US"),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    //**********Outputs******************************
    new cdk.CfnOutput(this, "DocToPdfApiUrl", {
      value: `${api.url}doctopdf`,
    });
    new cdk.CfnOutput(this, "SummarizeUrl", {
      value: `${api.url}summarize`,
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: `${contentBucket.bucketName}`,
    });
    new cdk.CfnOutput(this, "OutputTableName", {
      value: `${outputTable.tableName}`,
    });
    new cdk.CfnOutput(this, "DocumentTableName", {
      value: `${documentsTable.tableName}`,
    });
    new cdk.CfnOutput(this, "AppBucketName", {
      value: `${appBucket.bucketName}`,
    });
    new cdk.CfnOutput(this, "AppUrl", {
      value: `${distribution.domainName}`,
    });
  }
}
