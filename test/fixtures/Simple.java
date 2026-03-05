public class Simple {
    public void handleRequest(String input) {
        String validated = validate(input);
        String result = process(validated);
        respond(result);
    }

    private String validate(String input) {
        if (input == null || input.isEmpty()) {
            throw new IllegalArgumentException("Empty input");
        }
        return input.trim();
    }

    private String process(String data) {
        return transform(data);
    }

    private String transform(String data) {
        return data.toUpperCase();
    }

    private void respond(String result) {
        System.out.println(result);
    }
}
