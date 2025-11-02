// Это бэкенд-функция Vercel (Node.js)
// Имя файла /api/gemini.js означает, что он будет доступен по адресу /api/gemini

// 1. Секретный ключ берется из переменных окружения Vercel
const API_KEY = process.env.GEMINI_API_KEY; 
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

// 2. Промпт теперь живет на бэкенде
const SYSTEM_PROMPT = `Ты — модный ИИ-стилист. Твоя задача — проанализировать фотографию человека и дать оценку его образу. Отвечай на русском языке. Твой ответ должен быть четко структурирован по четырем пунктам, которые запросил пользователь, и никак иначе:

Вы одеты в: [краткий список одежды на фото]
Ваш стиль: [название стиля, например: 'Кэжуал', 'Спортивный', 'Деловой', 'Минимализм']
Сочетание одежды: [оценка от 7 до 10, никогда не ниже 7]
Что можно добавить: [1-3 конкретных совета, что добавить или изменить]`;

// 3. Копируем твою же функцию callGeminiWithRetry сюда, на бэкенд
async function callGeminiWithRetry(url, payload, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            // fetch() доступен в Node.js на Vercel
            const response = await fetch(`${url}?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Google API error! status: ${response.status}, body: ${errorBody}`);
            }

            const result = await response.json();

            if (result.candidates && result.candidates[0]?.content?.parts?.[0]) {
                return result.candidates[0].content.parts[0].text;
            } else {
                console.warn('Google API returned unexpected structure:', result);
                throw new Error('Не удалось получить анализ от ИИ (Google).');
            }
        } catch (error) {
            console.warn(`Попытка ${i + 1} не удалась: ${error.message}`);
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
    throw new Error('Не удалось подключиться к Google API после нескольких попыток.');
}

// 4. Основная функция-обработчик Vercel
export default async function handler(request, response) {
    // Принимаем только POST запросы
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // 5. Получаем base64-строку картинки из тела запроса от фронтенда
        const { imageData } = request.body;
        if (!imageData) {
            return response.status(400).json({ error: 'Картинка не получена (imageData is missing)' });
        }

        // 6. Готовим payload для Google
        const payload = {
            contents: [{
                role: "user",
                parts: [
                    { text: "Проанализируй одежду на этом фото." },
                    {
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: imageData
                        }
                    }
                ]
            }],
            systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
            }
        };

        // 7. Делаем запрос в Google (уже с бэкенда)
        const analysisText = await callGeminiWithRetry(API_URL, payload);

        // 8. Отправляем чистый текст обратно на фронтенд
        return response.status(200).json({ text: analysisText });

    } catch (error) {
        console.error('Ошибка на бэкенде (/api/gemini):', error.message);
        // 9. Отправляем ошибку на фронтенд
        return response.status(500).json({ error: `Ошибка сервера: ${error.message}` });
    }
}
