package main

import "fmt"

func main() {
	result := processInput("hello")
	fmt.Println(result)
}

func processInput(input string) string {
	validated := validate(input)
	return transform(validated)
}

func validate(input string) string {
	if len(input) == 0 {
		panic("empty input")
	}
	return input
}

func transform(input string) string {
	return input + "_processed"
}
