package navigation

type Speaker interface { Speak() string }

type Greeter struct{}

func (Greeter) Speak() string { return "你好 😀" }
