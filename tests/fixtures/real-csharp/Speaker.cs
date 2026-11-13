namespace NavigationExample;

public interface ISpeaker { string Speak(); }
public class Greeter : ISpeaker
{
    public string Speak() => "你好 😀";
}
