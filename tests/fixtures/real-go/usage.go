package navigation

func Message() string {
	var speaker Speaker = Greeter{}
	return speaker.Speak()
}
