using System;
using System.Linq;
using System.Reflection;
var asm = Assembly.LoadFrom(@"E:\ts-ai-bot\TS-AI-Bot\TS-AI-Bot\bin\Debug\net8.0\TSLib.dll");
var t = asm.GetType("TSLib.Scheduler.DedicatedTaskScheduler");
foreach (var c in t!.GetConstructors(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance))
{
    Console.WriteLine($"{c} | Public={c.IsPublic} | Family={c.IsFamily} | Assembly={c.IsAssembly} | Private={c.IsPrivate}");
}
var idType = asm.GetType("TSLib.Helper.Id");
Console.WriteLine($"Id type: {idType}");
if (idType != null)
{
    foreach (var c in idType.GetConstructors(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance))
        Console.WriteLine($"Id ctor: {c} | Public={c.IsPublic}");
    foreach (var m in idType.GetMethods(BindingFlags.Public|BindingFlags.Static|BindingFlags.DeclaredOnly))
        Console.WriteLine($"Id static: {m}");
}
