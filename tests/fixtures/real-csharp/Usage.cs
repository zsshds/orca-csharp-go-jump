namespace NavigationExample;

public static class Usage
{
    public static string Message()
    {
        ISpeaker speaker = new Greeter();
        return speaker.Speak();
    }
}
