"""Голоса Gemini Live, которые человек может выбрать в профиле (PROTEUS-182).

Список повторяет `app/packages/contracts/src/voices.ts`: имя здесь — имя голоса у Google, его же хранит профиль и присылает
приложение в `voiceName`. Неизвестное имя агент отвергает, а не подменяет другим голосом.
"""

GEMINI_VOICE_NAMES: frozenset[str] = frozenset(
    {
        "Kore",
        "Zephyr",
        "Leda",
        "Aoede",
        "Callirrhoe",
        "Autonoe",
        "Despina",
        "Erinome",
        "Laomedeia",
        "Achernar",
        "Gacrux",
        "Pulcherrima",
        "Vindemiatrix",
        "Sulafat",
        "Charon",
        "Puck",
        "Fenrir",
        "Orus",
        "Enceladus",
        "Iapetus",
        "Umbriel",
        "Algieba",
        "Algenib",
        "Rasalgethi",
        "Alnilam",
        "Schedar",
        "Achird",
        "Zubenelgenubi",
        "Sadachbia",
        "Sadaltager",
    }
)
