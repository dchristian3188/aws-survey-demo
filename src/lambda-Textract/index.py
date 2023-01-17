import textractcaller as tc
import trp.trp2 as t2
from trp import Document
import boto3
import json
import logging
import time
import os
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Variables
DYNAMODB_TABLENAME = os.environ["DYNAMODB_TABLENAME"]
SURVEY_KEY = os.environ["SURVEY_KEY"]
FIREHOSE_STREAM = os.environ["FIREHOSE_STREAM"]

# Clients
textract_client = boto3.client('textract')
firehose_client = boto3.client('firehose')

dynamoDBResource = boto3.resource('dynamodb')
dyanmoDBTable = dynamoDBResource.Table(DYNAMODB_TABLENAME)

# Functions
def get_textractQuestions(dynamoDBtable, keyID):
    logger.info("Getting questions from %s.", dynamoDBtable.table_name)
    try:
        response = dynamoDBtable.get_item(
            Key={
                "ID": keyID
            }
        )
        logger.info("Response from DyanmodDB: %s.", json.dumps(response))
    except ClientError:
        logger.exception("Couldn't read from table %s.",
                         dynamoDBtable.table_name)
        raise
    else:
        return response['Item']


def put_firehoseRecord(firehose, stream, data):
    try:
        data["processedTime"] = time.strftime(
            '%Y/%m/%d %H:%M:%S', time.localtime())
        response = firehose.put_record(
            DeliveryStreamName=stream,
            Record={
                'Data': json.dumps(data)
            })
        logger.info("Put record in stream %s.", stream)
    except ClientError:
        logger.exception("Couldn't put record in stream %s.", stream)
        raise
    else:
        return response

def invoke_textractQuery(textract, questions, s3path):
    logger.info("Running Textract against: %s.", s3path)
    logger.info("Using questions: %s.", questions)
    try:
        queries = []
        for query in questions["Questions"]["Queries"]:
            queries.append(tc.Query(text=query["text"], alias=query["alias"]))

        response = tc.call_textract(
            input_document=s3path,
            queries_config=tc.QueriesConfig(queries),
            features=[tc.Textract_Features.QUERIES],
            force_async_api=True,
            boto3_textract_client=textract)

        logger.debug("Response from Textract: %s.", json.dumps(response))
        doc_ev = Document(response)

        doc_ev: t2.TDocumentSchema = t2.TDocumentSchema().load(response)

        entities = {}
        for page in doc_ev.pages:
            query_answers = doc_ev.get_query_answers(page=page)
            if query_answers:
                for answer in query_answers:
                    entities[answer[1]] = answer[2]
        logger.info("Formatted response from Textract: %s.", json.dumps(entities))
    except ClientError:
        logger.exception("Couldn't invoke Textract.")
        raise
    else:
        return entities

def handler(event, context):
    logger.info("Processing. Using event: %s", json.dumps(event))
    try:
        responses = []
        for survey in event["Records"]:
            s3Path = f's3://{survey["s3"]["bucket"]["name"]}/{survey["s3"]["object"]["key"]}'
            logger.info("Starting s3 file: %s",s3Path)
            questions = get_textractQuestions(dyanmoDBTable, SURVEY_KEY)
            textractResponse = invoke_textractQuery(
                textract_client, questions, s3Path)
            firehoseResponse = put_firehoseRecord(
                firehose_client, FIREHOSE_STREAM, textractResponse)
            responses.append(firehoseResponse)
        return {
            'statusCode': 200,
            'body': responses
        }
    except:
        raise
