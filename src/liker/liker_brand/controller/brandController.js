import axios from 'axios';
import { ObjectId } from 'mongodb';
import { getDb } from '../../../../WB_module/database/config/database.js';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { likeBrand } from '../liker/likerBrand.js';

// Функция-обёртка для повторного выполнения функций
async function executeWithRetry(action, ...params) {
    const maxRetries = 1;
    // const delay = 60000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await action(...params);
        } catch (error) {
            if (attempt < maxRetries) {
                console.warn(`Ошибка в ${action.name}. Попытка ${attempt} из ${maxRetries}. Повтор через ${delay/1000} секунд...`, error);
                // await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`Достигнуто максимальное количество попыток для ${action.name}. Завершаем...`, error);
                sendErrorToTelegram(`Ошибка после ${maxRetries} попыток в ${action.name} для номера ${params[0]}.`, action.name);
                return 'ERROR_MAX_RETRIES';
            }
        }
    }
    return 'ERROR';
}

// Функция-обёртка для повторного выполнения функции likeBrand при ошибке
export async function retryLikeBrand(phoneNumber, proxy, url, retries = 1) {
    try {
        return await likeBrand(phoneNumber, proxy, url);
    } catch (error) {
        if (retries > 0) {
            console.warn(`Ошибка в функции likeBrand. Попытка ${10 - retries + 1} из 10. Повторяем...`);
            return await retryLikeBrand(phoneNumber, proxy, url, retries - 1);
        } else {
            console.error('Достигнуто максимальное количество попыток для функции likeBrand. Завершаем...');
            sendErrorToTelegram(`Ошибка после 10 попыток в функции likeBrand для номера ${phoneNumber}.`, 'likeBrand');
            return 'ERROR';
        }
    }
}

// Функции-обработчики
export async function likeBrandHandler(like, proxy, phoneNumber) {
    try {
        const outcome = await executeWithRetry(likeBrand, phoneNumber, proxy, like.url);
        if (outcome === 'ALREADY_LIKED') {
            console.warn(`Бренд уже добавлен в любимые для аккаунта: ${phoneNumber}`);
            return outcome;
        }
        if (outcome === 'LIKED') {
            return 'SUCCESS';
        }
        return outcome;
    } catch (error) {
        console.error('Ошибка в likeBrandHandler:', error);
        sendErrorToTelegram(error.message, 'likeBrandHandler');
        return 'ERROR';
    }
}