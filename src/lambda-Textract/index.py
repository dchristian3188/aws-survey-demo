import textractcaller as tc
import trp.trp2 as t2
from trp import Document
import boto3


textract = boto3.client('textract', region_name='us-east-2')


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
                
    print(entities)
    

def handler(event, context):

    return {
        'statusCode': 200,
        'body': invokeQuery()
    }
