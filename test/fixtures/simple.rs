fn main() {
    let data = read_input();
    let result = process(data);
    output(result);
}

fn read_input() -> String {
    String::from("hello")
}

fn process(data: String) -> String {
    let validated = validate(&data);
    transform(validated)
}

fn validate(data: &str) -> &str {
    if data.is_empty() {
        panic!("empty input");
    }
    data
}

fn transform(data: &str) -> String {
    data.to_uppercase()
}

fn output(result: String) {
    println!("{}", result);
}
