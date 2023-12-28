import axios from 'axios';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { getSessionByPhone } from '../../../../WB_module/session/controller/sessionController.js';
import { 
    getCurrentIP, 
    setupAxiosWithProxy 
} from '../../../../WB_module/network/controller/networkController.js';

// Функция извлечения имени бренда из URL
async function extractBrandFromURL(url) {
    const match = url.match(/\/brands\/([^/]+)/);
    return match ? match[1] : null;
}

// Функция получения ID бренда по имени бренда
async function extractIdFromBrandUrl(axiosProxyInstance, brandName, phoneNumber) {
    try {
        const response = await axiosProxyInstance.get(`https://www.wildberries.ru${brandName}.json`);
        return response.data.id;
    } catch (error) {
        console.error('Ошибка при получении ID бренда:', error.message);
        await sendErrorToTelegram(`Не удалось получить ID бренда для номера ${phoneNumber}.`, 'extractIdFromBrandUrl');
        return null;
    }
}

// Функция настройки экземпляра Axios с прокси
async function setupBrandAxiosInstanceWithProxy(proxyString, phoneNumber) {
    // Получение оригинального IP без прокси
    const originalIP = await getCurrentIP(axios);
    
    const axiosInstance = await setupAxiosWithProxy(proxyString);
    
    // Получение IP после применения прокси
    const currentIP = await getCurrentIP(axiosInstance);
    console.log('IP', originalIP, currentIP);
    if (!currentIP || currentIP === originalIP) {
        console.error("Не удалось настроить axios с прокси или IP не изменился:", proxyString);
        await sendErrorToTelegram(`Ошибка при настройке прокси для номера ${phoneNumber}.`, 'setupBrandAxiosInstanceWithProxy');
        throw new Error("Настройка Axios с прокси не удалась или IP не изменился");
    }

    return axiosInstance;
}

// Функция получения заголовков запроса с сессией
async function getRequestHeadersWithSession(session, referUrl, phoneNumber) {
    try {
        const cookiesString = await session.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        // console.log(cookiesString);

        return {
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://www.wildberries.ru',
            'Referer': referUrl,
            'Sec-Ch-Ua': '"Chromium";v="117", "Not;A=Brand";v="8"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': 'Windows',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': session.fingerprintUA,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Spa-Version': '9.3.138',
            'Cookie': cookiesString
        };
    } catch (error) {
        console.error('Ошибка при получении заголовков запроса с сессией:', error.message);
        await sendErrorToTelegram(`Ошибка при формировании заголовков для номера ${phoneNumber}.`, 'getRequestHeadersWithSession');
        throw error;
    }
}

// Функция получения списка любимых брендов
async function getFavoriteBrands(axiosProxyInstance, checkHeaders, phoneNumber) {
    checkHeaders.Referer = 'https://www.wildberries.ru';
    try {
        const response = await axiosProxyInstance.request({
            url: 'https://www.wildberries.ru',
            method: 'post',
            headers: checkHeaders,
        });
        return response.data.value.favoriteBrands;
    } catch (error) {
        console.error('Ошибка при получении любимых брендов:', error.message);
        await sendErrorToTelegram(`Ошибка при получении списка любимых брендов для номера ${phoneNumber}.`, 'getFavoriteBrands');
        return null;
    }
}

// Функция проверки сессии бренда
async function checkBrandSession(phoneNumber, axiosProxyInstance) {
    const session = await getSessionByPhone(phoneNumber);
    const checkHeaders = await getRequestHeadersWithSession(session, 'https://www.wildberries.ru', phoneNumber);
    // console.log(checkHeaders);

    try {
        const response = await axiosProxyInstance.request({
            url: 'https://www.wildberries.ru',
            method: 'post',
            headers: checkHeaders,
        });
        
        // console.log(response.data.value.favoriteBrands);
        return {
            status: 'AuthSuccess',
            checkHeaders: checkHeaders,
            favoriteBrands: response.data.value.favoriteBrands
        };

    } catch (error) {
        // Check for the specific error data
        if (error.response && error.response.data && error.response.data.ResultState === -1 && error.response.data.Value === 'Необходима авторизация пользователя') {
            console.error('Требуется авторизация пользователя');
            await sendErrorToTelegram(`Не удалось авторизовать пользователя для номера ${phoneNumber}.`, 'checkBrandSession');
            return {
                status: 'AuthError'
            };
        } else {
            console.error('Error:', error.message);
            await sendErrorToTelegram(`Ошибка при проверке сессии бренда для номера ${phoneNumber}.`, 'checkBrandSession');
            return {
                status: 'Error',
                message: error.message
            };
        }
    }
}

// Функция извлечения brandId и вызова функции на добавление бренда в любимые
async function postBrandLike(axiosProxyInstance, checkHeaders, favoriteBrands, brandRefURL, phoneNumber) {
    try {
        const brandName = await extractBrandFromURL(brandRefURL);
        const brandId = await extractIdFromBrandUrl(axiosProxyInstance, brandName, phoneNumber);

        const isBrandAlreadyLiked = await favoriteBrands.some(brand => brand.brandCod === brandId);
        
        if (isBrandAlreadyLiked) {
            console.log(`Бренд с ID ${brandId} уже добавлен в любимые.`);
            return 'ALREADY_LIKED'; // Return the outcome
        }

        await sendBrandLikeRequest(axiosProxyInstance, checkHeaders, brandId, brandRefURL, phoneNumber);
        return 'LIKED'; // Return the outcome
    } catch (error) {
        console.error('Ошибка в функции postBrandLike:', error.message);
        return 'ERROR'; // Return the outcome indicating an error
    }
}

//  Функция запроса добавления бренда в любимые
async function sendBrandLikeRequest(axiosProxyInstance, checkHeaders, brandId, brandRefURL, phoneNumber) {
    try {
        checkHeaders.Referer = brandRefURL;
        const response = await axiosProxyInstance.request({
            url: 'https://www.wildberries.ru',
            method: 'post',
            headers: checkHeaders,
            data: `brandId=${brandId}`,
        });
        // console.log(response.data.value.voteCount);
        const favoriteBrands = await getFavoriteBrands(axiosProxyInstance, checkHeaders, phoneNumber);
        const isBrandLiked = await favoriteBrands.some(brand => brand.brandCod === brandId);
        if (response.data.value.voteCount && isBrandLiked) {
            console.log(`Успешно добавлен бренд с ID ${brandId} в любимые.`);
        } else {
            console.warn(`Не удалось добавить бренд с ID ${brandId} в любимые.`);
        }
    } catch (error) {
        await sendErrorToTelegram(`Ошибка при отправке запроса на добавление бренда для номера ${phoneNumber}.`, 'sendBrandLikeRequest');
        console.error('Ошибка при отправке запроса на добавление в любимые:', error.message);
    }
}

// Основная функция добавления бренд в любимые
export async function likeBrand(phoneNumber, proxyString, brandRefURL) {
    try {
        const axiosProxyInstance = await setupBrandAxiosInstanceWithProxy(proxyString, phoneNumber);
        const checkedSession = await checkBrandSession(phoneNumber, axiosProxyInstance);
        return await postBrandLike(axiosProxyInstance, checkedSession.checkHeaders, checkedSession.favoriteBrands, brandRefURL, phoneNumber);
    } catch (error) {
        console.error('Ошибка в функции likeBrand:', error.message);
        await sendErrorToTelegram(`Ошибка в основной функции добавления бренда для номера ${phoneNumber}.`, 'likeBrand');
        return 'ERROR';
    }
}
