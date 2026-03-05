def handle_request(request):
    validate_input(request)
    data = process_data(request.body)
    return format_response(data)

def validate_input(request):
    if not request.body:
        raise ValueError("Empty request")

def process_data(body):
    cleaned = sanitize(body)
    return transform(cleaned)

def sanitize(data):
    return data.strip()

def transform(data):
    return data.upper()

def format_response(data):
    return {"status": "ok", "data": data}
