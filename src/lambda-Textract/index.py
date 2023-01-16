import textractcaller as tc
import trp.trp2 as t2
from trp import Document
import boto3
import base64
import json
import logging
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


textract = boto3.client('textract')
kinesis = boto3.client('kinesis')
firehose = boto3.client('firehose')


# def put_record(kinesis_client, stream, data, partition_key):
#     """
#     Puts data into the stream. The data is formatted as JSON before it is passed
#     to the stream.

#     :param kinesis_client: boto3 Kinesis client
#     :param stream: name of the Kinesis stream
#     :param data: The data to put in the stream.
#     :param partition_key: The partition key to use for the data.
#     :return: Metadata about the record, including its shard ID and sequence number.
#     """
#     try:
#         response = kinesis_client.put_record(
#             StreamName=stream,
#             Data=json.dumps(data),
#             PartitionKey=partition_key)
#         logger.info("Put record in stream %s.", stream)
#     except ClientError:
#         logger.exception("Couldn't put record in stream %s.", stream)
#         raise
#     else:
#         return response


def put_record(firehose, stream, data):
    """
    Puts data into the stream. The data is formatted as JSON before it is passed
    to the stream.

    :param firehose: boto3 firehose client
    :param stream: name of the firehose stream
    :param data: The data to put in the stream.
    :return: Metadata about the record, including its shard ID and sequence number.
    """
    try:
        response = firehose.put_record(
            DeliveryStreamName=stream,
            Record= {
                'Data': json.dumps(data)
            })
        logger.info("Put record in stream %s.", stream)
    except ClientError:
        logger.exception("Couldn't put record in stream %s.", stream)
        raise
    else:
        return response


def invokeTextract():
    response = textract.detect_document_text(
    Document={
        'S3Object': {
            'Bucket': "surveydemostack-surveybucketee9ca9bc-1sohcggpinv32",
            'Name': "IMG_6155.png"
        }
    })
    print(response)


def invokeQuery():
    query1 = tc.Query(text="Informative?",
                   alias="Informative")
    query2 = tc.Query(text="Please rate the quality of the service you received from your server",
                   alias="SERVER")

    

    response = tc.call_textract(
        input_document="s3://surveydemostack-surveybucketee9ca9bc-1sohcggpinv32/IMG_6155.png",
        queries_config=tc.QueriesConfig(queries=[query1, query2]),
        features=[tc.Textract_Features.QUERIES],
        force_async_api=True,
        boto3_textract_client=textract)
    
    doc_ev = Document(response)

    doc_ev: t2.TDocumentSchema = t2.TDocumentSchema().load(response)

    entities = {}
    for page in doc_ev.pages:
        query_answers = doc_ev.get_query_answers(page=page)
        if query_answers:
            for answer in query_answers:
                entities[answer[1]] = answer[2]

    return entities


def handler(event, context):

    return {
        'statusCode': 200,
        'body': invokeQuery()
    }

results = invokeQuery()

#response = put_record(kinesis,"SurveyDemoStack-surveyKinesisStream8042F8C3-VjS6Alb9r3C8",results,"surveys")
response = put_record(firehose,"SurveyDemoStack-surveyKinesisFirehose-qR8lWUQB1LAR",results)
print(response)