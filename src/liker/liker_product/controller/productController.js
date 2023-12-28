import axios from 'axios';
import { ObjectId } from 'mongodb';
import { getDb } from '../../../../WB_module/database/config/database.js';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { likeProduct } from '../liker/likerProduct.js';

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
                await sendErrorToTelegram(`Ошибка после ${maxRetries} попыток в ${action.name} для номера ${params[0]}.`, action.name);
                return 'ERROR_MAX_RETRIES';
            }
        }
    }
    return 'ERROR';
}

// Функция-обёртка для повторного выполнения функции likeProduct при ошибке
export async function retryLikeProduct(phoneNumber, proxy, url, retries = 1, delay = 60000) {
    try {
        return await likeProduct(phoneNumber, proxy, url);
    } catch (error) {
        if (retries > 0) {
            console.warn(`Ошибка в функции likeProduct. Попытка ${4 - retries} из 3. Повторяем...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            await retryLikeProduct(phoneNumber, proxy, url, retries - 1);
        } else {
            console.error('Достигнуто максимальное количество попыток для функции likeProduct. Завершаем...');
            await sendErrorToTelegram(`Ошибка после 10 попыток в функции likeProduct для номера ${phoneNumber}.`, 'likeProduct');
            return 'ERROR';
        }
    }
}


export async function likeProductHandler(like, proxy, phoneNumber) {
    try {
        const outcome = await executeWithRetry(likeProduct, phoneNumber, proxy, like.url);
        if (outcome === 'ALREADY_LIKED') {
            console.warn(`Продукт уже добавлен в любимые для аккаунта: ${phoneNumber}`);
            return outcome;
        }
        if (outcome === 'LIKED') {
            return 'SUCCESS';
        }
        return outcome;
    } catch (error) {
        console.error('Ошибка в likeProductHandler:', error);
        await sendErrorToTelegram(error.message, 'likeProductHandler');
        return 'ERROR';
    }
}