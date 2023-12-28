import axios from 'axios';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { getSessionByPhone } from '../../../../WB_module/session/controller/sessionController.js';
import { 
    getCurrentIP, 
    setupAxiosWithProxy 
} from '../../../../WB_module/network/controller/networkController.js';

// Функция извлечения артикула продукта из URL
async function extractArticleFromURL(url) {
    const match = url.match(/\/(\d+)\/detail\.aspx/);
    return match ? match[1] : null;
}

// Функция получения optionId продукта по артикулу бренда
async function extractOptionIdFromBrandUrl(axiosProxyInstance, article, phoneNumber) {
    try {
        const response = await axiosProxyInstance.get(`https://www.wildberries.ru=${article}`);
        const optionId = response.data.data.products[0].sizes[0].optionId;;
        return optionId;
    } catch (error) {
        console.error('Ошибка при получении ID бренда:', error.message);
        await  sendErrorToTelegram(`Не удалось получить ID бренда для номера ${phoneNumber}.`, 'extractIdFromBrandUrl');
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
        await  sendErrorToTelegram(`Ошибка при настройке прокси для номера ${phoneNumber}.`, 'setupBrandAxiosInstanceWithProxy');
        throw new Error("Настройка Axios с прокси не удалась или IP не изменился");
    }

    return axiosInstance;
}

// Функция получения списка любимых продуктов
async function getFavoriteProducts(axiosProxyInstance, checkHeaders, phoneNumber, productRefURL) {
    checkHeaders.Referer = productRefURL;
    try {
        const response = await axiosProxyInstance.request({
            url: 'https://www.wildberries.ru',
            method: 'get',
            headers: checkHeaders,
        });
        return response.data.data.model.products;
    } catch (error) {
        console.error('Ошибка при получении любимых продуктов:', error.message);
        sendErrorToTelegram(`Ошибка при получении списка любимых продуктов для номера ${phoneNumber}.`, 'getFavoriteProducts');
        return null;
    }
}

// Функция получения заголовков запроса с сессией
async function getRequestHeadersWithSession(session, referUrl, phoneNumber) {
    try {
        const cookiesString = await session.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

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

// Функция проверки сессии продукта
async function checkProductSession(phoneNumber, axiosProxyInstance, productRefURL) {
    const session = await getSessionByPhone(phoneNumber);
    const checkHeaders = await getRequestHeadersWithSession(session, productRefURL, phoneNumber);
    // console.log(checkHeaders);

    try {
        const response = await axiosProxyInstance.request({
            url: 'https://wildberries.ru/',
            method: 'get',
            headers: checkHeaders,
        });
        
        //console.log(response.data.data.model.products);
        return {
            status: 'AuthSuccess',
            checkHeaders: checkHeaders,
            ponedProducts: response.data.data.model.products
        };

    } catch (error) {
        if (error.response && error.response.data && error.response.data.ResultState === -1 && error.response.data.Value === 'Необходима авторизация пользователя') {
            console.error('Требуется авторизация пользователя');
            await sendErrorToTelegram(`Не удалось авторизовать пользователя для номера ${phoneNumber}.`, 'checkProductSession');
            return {
                status: 'AuthError'
            };
        } else {
            console.error('Error:', error.message);
            await sendErrorToTelegram(`Ошибка при проверке сессии продукта для номера ${phoneNumber}.`, 'checkProductSession');
            return {
                status: 'Error',
                message: error.message
            };
        }
    }
}

// Функция извлечения brandId и вызова функции на добавление бренда в любимые
async function postProductLike(axiosProxyInstance, checkHeaders, ponedProducts, productRefURL, phoneNumber, originalArticle, optionId) {
    try {
        // console.log(originalArticle)
        // Проверкана наличие текущего brandId в favoriteBrands
        const isBrandAlreadyLiked = await ponedProducts.some(product => product.article == originalArticle);
        if (isBrandAlreadyLiked) {
            console.log(`Продукт с артикулом ${originalArticle} уже добавлен в любимые.`);
            return 'ALREADY_LIKED';
        }

        await sendProductLikeRequest(axiosProxyInstance, checkHeaders, originalArticle, optionId, productRefURL, phoneNumber);
        return 'LIKED';
    } catch (error) {
        await sendErrorToTelegram(`Ошибка при добавлении продукта в любимые для номера ${phoneNumber}.`, 'postProductLike');
        console.error('Ошибка в функции postProductLike:', error.message);
    }
}

//  Функция запроса добавления продукта в любимые
async function sendProductLikeRequest(axiosProxyInstance, checkHeaders, originalArticle, optionId, productRefURL, phoneNumber) {
    try {
        checkHeaders.Referer = productRefURL;
        const response = await axiosProxyInstance.request({
            url: 'https://www.wildberries.ru/',
            method: 'post',
            headers: checkHeaders,
            data: `cod1S=${originalArticle}&characteristicId=${optionId}`,
        });
        // console.log(response.data.resultState);
        const favoriteProducts = await getFavoriteProducts(axiosProxyInstance, checkHeaders, phoneNumber, productRefURL);
        const isProductLiked = await favoriteProducts.some(product => product.article == originalArticle);
        if (isProductLiked) {
            console.log(`Успешно добавлен продукт с артикулом ${originalArticle} в любимые.`);
        } else {
            console.warn(`Не удалось добавить бренд с артикулом ${originalArticle} в любимые.`);
        }
    } catch (error) {
        await sendErrorToTelegram(`Ошибка при отправке запроса на добавление бренда для номера ${phoneNumber}.`, 'sendProductLikeRequest');
        console.error('Ошибка при отправке запроса на добавление в любимые:', error.message);
    }
}

// Основная функция добавления продукта в любимые
export async function likeProduct(phoneNumber, proxyString, productRefURL) {
    try {
        const axiosProxyInstance = await setupBrandAxiosInstanceWithProxy(proxyString, phoneNumber);
        const article = await extractArticleFromURL(productRefURL);
        const optionId = await extractOptionIdFromBrandUrl(axiosProxyInstance, article, phoneNumber);
        const checkedSession = await checkProductSession(phoneNumber, axiosProxyInstance, productRefURL);
        return await postProductLike(axiosProxyInstance, checkedSession.checkHeaders, checkedSession.ponedProducts, productRefURL, phoneNumber, article, optionId);
    } catch (error) {
        console.error('Ошибка в функции likeProduct:', error.message);
        sendErrorToTelegram(`Ошибка в основной функции добавления продукта для номера ${phoneNumber}.`, 'likeProduct');
        return 'ERROR';
    }
}